import chalk from "chalk";
import * as path from "path";
import * as fs from "fs-extra";
import * as crypto from "crypto";
import { execSync } from "child_process";

import * as cdk from "@aws-cdk/core";
import * as s3 from "@aws-cdk/aws-s3";
import * as s3Assets from "@aws-cdk/aws-s3-assets";
import * as acm from "@aws-cdk/aws-certificatemanager";
import * as iam from "@aws-cdk/aws-iam";
import * as lambda from "@aws-cdk/aws-lambda";
import * as route53 from "@aws-cdk/aws-route53";
import * as route53Patterns from "@aws-cdk/aws-route53-patterns";
import * as route53Targets from "@aws-cdk/aws-route53-targets";
import * as cf from "@aws-cdk/aws-cloudfront";
import * as cfOrigins from "@aws-cdk/aws-cloudfront-origins";
import { AwsCliLayer } from "@aws-cdk/lambda-layer-awscli";

import { App } from "./App";
import {
  BaseSiteReplaceProps,
  BaseSiteEnvironmentOutputsInfo,
  buildErrorResponsesFor404ErrorPage,
  buildErrorResponsesForRedirectToIndex,
} from "./BaseSite";

export enum StaticSiteErrorOptions {
  REDIRECT_TO_INDEX_PAGE = "REDIRECT_TO_INDEX_PAGE",
}

export interface StaticSiteProps {
  readonly path: string;
  readonly indexPage?: string;
  readonly errorPage?: string | StaticSiteErrorOptions;
  readonly buildCommand?: string;
  readonly buildOutput?: string;
  readonly fileOptions?: StaticSiteFileOption[];
  readonly replaceValues?: StaticSiteReplaceProps[];
  readonly customDomain?: string | StaticSiteDomainProps;
  readonly s3Bucket?: s3.BucketProps;
  readonly cfDistribution?: StaticSiteCdkDistributionProps;
  readonly environment?: { [key: string]: string };
  readonly disablePlaceholder?: boolean;
}

export interface StaticSiteDomainProps {
  readonly domainName: string;
  readonly domainAlias?: string;
  readonly hostedZone?: string | route53.IHostedZone;
  readonly certificate?: acm.ICertificate;
  readonly isExternalDomain?: boolean;
}

export interface StaticSiteFileOption {
  readonly exclude: string | string[];
  readonly include: string | string[];
  readonly cacheControl: string;
}

export type StaticSiteReplaceProps = BaseSiteReplaceProps;

export interface StaticSiteCdkDistributionProps
  extends Omit<cf.DistributionProps, "defaultBehavior"> {
  readonly defaultBehavior?: cf.AddBehaviorOptions;
}

export class StaticSite extends cdk.Construct {
  public readonly s3Bucket: s3.Bucket;
  public readonly cfDistribution: cf.Distribution;
  public readonly hostedZone?: route53.IHostedZone;
  public readonly acmCertificate?: acm.ICertificate;
  private readonly props: StaticSiteProps;
  private readonly deployId: string;
  private readonly assets: s3Assets.Asset[];
  private readonly customResourceFn: lambda.Function;
  private readonly environment: Record<string, string> = {};
  private readonly replaceValues: StaticSiteReplaceProps[] = [];

  constructor(scope: cdk.Construct, id: string, props: StaticSiteProps) {
    super(scope, id);

    // Handle remove (ie. sst remove)
    const root = scope.node.root as App;
    const isSstStart = root.local;
    const skipBuild = root.skipBuild;
    const buildDir = root.buildDir;
    const fileSizeLimit = root.isJestTest()
      ? // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore: "jestFileSizeLimitOverride" not exposed in props
        props.jestFileSizeLimitOverride || 200
      : 200;
    const disablePlaceholder = props.disablePlaceholder || false;

    this.props = props;
    this.environment = props.environment || {};
    this.replaceValues = props.replaceValues || [];

    // Generate environment placeholders to be replaced
    // ie. environment => { REACT_APP_API_URL: api.url }
    //     environment => REACT_APP_API_URL="{{ REACT_APP_API_URL }}"
    //
    const environmentOutputs: Record<string, string> = {};
    for (const [key, value] of Object.entries(props.environment || {})) {
      const token = `{{ ${key} }}`;
      this.environment[key] = token;
      this.replaceValues.push(
        {
          files: "**/*.js",
          search: token,
          replace: value,
        },
        {
          files: "index.html",
          search: token,
          replace: value,
        }
      );
      const outputId = `SstStaticSiteEnv_${key}`;
      const output = new cdk.CfnOutput(this, outputId, { value });
      environmentOutputs[key] = cdk.Stack.of(this).getLogicalId(output);
    }
    root.registerSiteEnvironment({
      id,
      path: props.path,
      stack: cdk.Stack.of(this).node.id,
      environmentOutputs,
    } as BaseSiteEnvironmentOutputsInfo);

    // Validate input
    this.validateCustomDomainSettings();

    // Build website
    this.assets = this.buildApp(fileSizeLimit, buildDir, isSstStart, skipBuild);
    const assetsHash = crypto
      .createHash("md5")
      .update(this.assets.map(({ assetHash }) => assetHash).join(""))
      .digest("hex");
    this.deployId = isSstStart ? `deploy-live` : `deploy-${assetsHash}`;

    this.s3Bucket = this.createS3Bucket();
    this.customResourceFn = this.createCustomResourceFunction();
    this.hostedZone = this.lookupHostedZone();
    this.acmCertificate = this.createCertificate();
    this.cfDistribution = this.createCfDistribution(
      isSstStart,
      disablePlaceholder
    );
    this.createRoute53Records();
    this.createS3Deployment();
  }

  public get url(): string {
    return `https://${this.cfDistribution.distributionDomainName}`;
  }

  public get customDomainUrl(): string | undefined {
    const { customDomain } = this.props;
    if (!customDomain) {
      return;
    }

    if (typeof customDomain === "string") {
      return `https://${customDomain}`;
    } else {
      return `https://${customDomain.domainName}`;
    }
  }

  public get bucketArn(): string {
    return this.s3Bucket.bucketArn;
  }

  public get bucketName(): string {
    return this.s3Bucket.bucketName;
  }

  public get distributionId(): string {
    return this.cfDistribution.distributionId;
  }

  public get distributionDomain(): string {
    return this.cfDistribution.distributionDomainName;
  }

  protected validateCustomDomainSettings() {
    const { customDomain } = this.props;

    if (!customDomain) {
      return;
    }

    if (typeof customDomain === "string") {
      return;
    }

    if (customDomain.isExternalDomain === true) {
      if (!customDomain.certificate) {
        throw new Error(
          `A valid certificate is required when "isExternalDomain" is set to "true".`
        );
      }
      if (customDomain.domainAlias) {
        throw new Error(
          `Domain alias is only supported for domains hosted on Amazon Route 53. Do not set the "customDomain.domainAlias" when "isExternalDomain" is enabled.`
        );
      }
      if (customDomain.hostedZone) {
        throw new Error(
          `Hosted zones can only be configured for domains hosted on Amazon Route 53. Do not set the "customDomain.hostedZone" when "isExternalDomain" is enabled.`
        );
      }
    }
  }

  private createS3Bucket(): s3.Bucket {
    let { s3Bucket } = this.props;
    s3Bucket = s3Bucket || {};

    // Validate s3Bucket
    if (s3Bucket.websiteIndexDocument) {
      throw new Error(
        `Do not configure the "s3Bucket.websiteIndexDocument". Use the "indexPage" to configure the StaticSite index page.`
      );
    }

    if (s3Bucket.websiteErrorDocument) {
      throw new Error(
        `Do not configure the "s3Bucket.websiteErrorDocument". Use the "errorPage" to configure the StaticSite index page.`
      );
    }

    return new s3.Bucket(this, "Bucket", {
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      ...s3Bucket,
    });
  }

  private createCustomResourceFunction(): lambda.Function {
    const layer = new AwsCliLayer(this, "AwsCliLayer");

    // Create a Lambda function that will be doing the uploading
    const uploader = new lambda.Function(this, "CustomResourceUploader", {
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../assets/StaticSite/custom-resource")
      ),
      layers: [layer],
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: "s3-upload.handler",
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
    });
    this.s3Bucket.grantReadWrite(uploader);
    this.assets.forEach((asset) => asset.grantRead(uploader));

    // Create the custom resource function
    const handler = new lambda.Function(this, "CustomResourceHandler", {
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../assets/StaticSite/custom-resource")
      ),
      layers: [layer],
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: "index.handler",
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        UPLOADER_FUNCTION_NAME: uploader.functionName,
      },
    });
    this.s3Bucket.grantReadWrite(handler);
    uploader.grantInvoke(handler);

    // Grant permissions to invalidate CF Distribution
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "cloudfront:GetInvalidation",
          "cloudfront:CreateInvalidation",
        ],
        resources: ["*"],
      })
    );

    return handler;
  }

  private buildApp(
    fileSizeLimit: number,
    buildDir: string,
    isSstStart: boolean,
    skipBuild: boolean
  ): s3Assets.Asset[] {
    // Local development or skip build => stub asset
    if (isSstStart || skipBuild) {
      return [
        new s3Assets.Asset(this, "Asset", {
          path: path.resolve(__dirname, "../assets/StaticSite/stub"),
        }),
      ];
    }

    const { path: sitePath, buildCommand } = this.props;
    const buildOutput = this.props.buildOutput || ".";

    // validate site path exists
    if (!fs.existsSync(sitePath)) {
      throw new Error(
        `No path found at "${path.resolve(sitePath)}" for the "${
          this.node.id
        }" StaticSite.`
      );
    }

    // Build and package user's website

    // build
    if (buildCommand) {
      try {
        console.log(chalk.grey(`Building static site ${sitePath}`));
        execSync(buildCommand, {
          cwd: sitePath,
          stdio: "inherit",
          env: { ...process.env, ...this.environment },
        });
      } catch (e) {
        throw new Error(
          `There was a problem building the "${this.node.id}" StaticSite.`
        );
      }
    }

    // validate buildOutput exists
    const siteOutputPath = path.resolve(path.join(sitePath, buildOutput));
    if (!fs.existsSync(siteOutputPath)) {
      throw new Error(
        `No build output found at "${siteOutputPath}" for the "${this.node.id}" StaticSite.`
      );
    }

    // create zip files
    const script = path.join(__dirname, "../assets/StaticSite/archiver.js");
    const zipPath = path.resolve(
      path.join(buildDir, `StaticSite-${this.node.id}-${this.node.addr}`)
    );
    // clear zip path to ensure no partX.zip remain from previous build
    fs.removeSync(zipPath);
    const cmd = ["node", script, siteOutputPath, zipPath, fileSizeLimit].join(
      " "
    );

    try {
      execSync(cmd, {
        cwd: sitePath,
        stdio: "inherit",
      });
    } catch (e) {
      throw new Error(
        `There was a problem generating the "${this.node.id}" StaticSite package.`
      );
    }

    // create assets
    const assets = [];
    for (let partId = 0; ; partId++) {
      const zipFilePath = path.join(zipPath, `part${partId}.zip`);
      if (!fs.existsSync(zipFilePath)) {
        break;
      }

      assets.push(
        new s3Assets.Asset(this, `Asset${partId}`, {
          path: zipFilePath,
        })
      );
    }
    return assets;
  }

  protected lookupHostedZone(): route53.IHostedZone | undefined {
    const { customDomain } = this.props;

    // Skip if customDomain is not configured
    if (!customDomain) {
      return;
    }

    let hostedZone;

    if (typeof customDomain === "string") {
      hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: customDomain,
      });
    } else if (cdk.Construct.isConstruct(customDomain.hostedZone)) {
      hostedZone = customDomain.hostedZone as route53.IHostedZone;
    } else if (typeof customDomain.hostedZone === "string") {
      hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: customDomain.hostedZone,
      });
    } else if (typeof customDomain.domainName === "string") {
      // Skip if domain is not a Route53 domain
      if (customDomain.isExternalDomain === true) {
        return;
      }

      hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: customDomain.domainName,
      });
    } else {
      hostedZone = customDomain.hostedZone as route53.IHostedZone;
    }

    return hostedZone;
  }

  private createCertificate(): acm.ICertificate | undefined {
    const { customDomain } = this.props;

    if (!customDomain) {
      return;
    }

    let acmCertificate;

    // HostedZone is set for Route 53 domains
    if (this.hostedZone) {
      if (typeof customDomain === "string") {
        acmCertificate = new acm.DnsValidatedCertificate(this, "Certificate", {
          domainName: customDomain,
          hostedZone: this.hostedZone,
          region: "us-east-1",
        });
      } else if (customDomain.certificate) {
        acmCertificate = customDomain.certificate;
      } else {
        acmCertificate = new acm.DnsValidatedCertificate(this, "Certificate", {
          domainName: customDomain.domainName,
          hostedZone: this.hostedZone,
          region: "us-east-1",
        });
      }
    }
    // HostedZone is NOT set for non-Route 53 domains
    else {
      if (typeof customDomain !== "string") {
        acmCertificate = customDomain.certificate;
      }
    }

    return acmCertificate;
  }

  private createCfDistribution(
    isSstStart: boolean,
    disablePlaceholder: boolean
  ): cf.Distribution {
    const { cfDistribution, customDomain } = this.props;
    const indexPage = this.props.indexPage || "index.html";
    const errorPage = this.props.errorPage;

    const cfDistributionProps = cfDistribution || {};

    // Validate input
    if (cfDistributionProps.certificate) {
      throw new Error(
        `Do not configure the "cfDistribution.certificate". Use the "customDomain" to configure the StaticSite domain certificate.`
      );
    }
    if (cfDistributionProps.domainNames) {
      throw new Error(
        `Do not configure the "cfDistribution.domainNames". Use the "customDomain" to configure the StaticSite domain.`
      );
    }

    // Build domainNames
    const domainNames = [];
    if (!customDomain) {
      // no domain
    } else if (typeof customDomain === "string") {
      domainNames.push(customDomain);
    } else {
      domainNames.push(customDomain.domainName);
    }

    // Build errorResponses
    let errorResponses;
    // case: sst start => showing stub site, and redirect all routes to the index page
    if (isSstStart && !disablePlaceholder) {
      errorResponses = buildErrorResponsesForRedirectToIndex(indexPage);
    } else if (errorPage) {
      if (cfDistributionProps.errorResponses) {
        throw new Error(
          `Cannot configure the "cfDistribution.errorResponses" when "errorPage" is passed in. Use one or the other to configure the behavior for error pages.`
        );
      }

      errorResponses =
        errorPage === StaticSiteErrorOptions.REDIRECT_TO_INDEX_PAGE
          ? buildErrorResponsesForRedirectToIndex(indexPage)
          : buildErrorResponsesFor404ErrorPage(errorPage);
    }

    // Create CF distribution
    return new cf.Distribution(this, "Distribution", {
      // these values can be overwritten by cfDistributionProps
      defaultRootObject: indexPage,
      errorResponses,
      ...cfDistributionProps,
      // these values can NOT be overwritten by cfDistributionProps
      domainNames,
      certificate: this.acmCertificate,
      defaultBehavior: {
        origin: new cfOrigins.S3Origin(this.s3Bucket, {
          originPath: this.deployId,
        }),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        ...(cfDistributionProps.defaultBehavior || {}),
      },
    });
  }

  protected createRoute53Records(): void {
    const { customDomain } = this.props;

    if (!customDomain || !this.hostedZone) {
      return;
    }

    let recordName;
    let domainAlias;
    if (typeof customDomain === "string") {
      recordName = customDomain;
    } else {
      recordName = customDomain.domainName;
      domainAlias = customDomain.domainAlias;
    }

    // Create DNS record
    new route53.ARecord(this, "AliasRecord", {
      recordName,
      zone: this.hostedZone,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(this.cfDistribution)
      ),
    });

    // Create Alias redirect record
    if (domainAlias) {
      new route53Patterns.HttpsRedirect(this, "Redirect", {
        zone: this.hostedZone,
        recordNames: [domainAlias],
        targetDomain: recordName,
      });
    }
  }

  private createS3Deployment(): void {
    const { fileOptions } = this.props;

    // Create custom resource
    new cdk.CustomResource(this, "CustomResource", {
      serviceToken: this.customResourceFn.functionArn,
      resourceType: "Custom::SSTBucketDeployment",
      properties: {
        Sources: this.assets.map((asset) => ({
          BucketName: asset.s3BucketName,
          ObjectKey: asset.s3ObjectKey,
        })),
        DestinationBucketName: this.s3Bucket.bucketName,
        DestinationBucketKeyPrefix: this.deployId,
        DistributionId: this.cfDistribution.distributionId,
        DistributionPaths: ["/*"],
        FileOptions: (fileOptions || []).map(
          ({ exclude, include, cacheControl }) => {
            if (typeof exclude === "string") {
              exclude = [exclude];
            }
            if (typeof include === "string") {
              include = [include];
            }
            const options = [];
            exclude.forEach((per) => options.push("--exclude", per));
            include.forEach((per) => options.push("--include", per));
            options.push("--cache-control", cacheControl);
            return options;
          }
        ),
        ReplaceValues: this.replaceValues,
      },
    });
  }
}

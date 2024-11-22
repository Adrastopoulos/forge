import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsp from "aws-cdk-lib/aws-ecs-patterns";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as triggers from "aws-cdk-lib/triggers";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cr from "aws-cdk-lib/custom-resources";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as sm from "aws-cdk-lib/aws-secretsmanager";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as lambdanode from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface SonarQubeConstructProps {
  vpc: ec2.IVpc;
  eip: ec2.CfnEIP;
}

export class SonarQubeConstruct extends Construct {
  public readonly service: ecsp.ApplicationLoadBalancedFargateService;
  public readonly sonarSecurityGroup: ec2.SecurityGroup;
  public readonly project: codebuild.Project;

  constructor(scope: Construct, id: string, props: SonarQubeConstructProps) {
    super(scope, id);

    const DB_NAME = `sonarqube`;
    const DB_PORT = 5432;
    const SONAR_PORT = 9000;

    this.sonarSecurityGroup = new ec2.SecurityGroup(
      this,
      `${id}SonarSecurityGroup`,
      {
        securityGroupName: `${id}SonarSecurityGroup`,
        description: "Contains ECS cluster + ALB + Lambda + codebuild project",
        vpc: props.vpc,
        allowAllOutbound: true,
      }
    );

    const dbSecurityGroup = new ec2.SecurityGroup(
      this,
      `${id}DBSecurityGroup`,
      {
        securityGroupName: `${id}DBSecurityGroup`,
        description: "Embeds Aurora RDS",
        vpc: props.vpc,
        allowAllOutbound: true,
      }
    );

    dbSecurityGroup.addIngressRule(
      this.sonarSecurityGroup,
      ec2.Port.tcp(DB_PORT),
      `Allow AuroraDB connection from sonar security group`
    );

    this.sonarSecurityGroup.addIngressRule(
      this.sonarSecurityGroup,
      ec2.Port.tcp(SONAR_PORT),
      "Allow connection to sonarqube server"
    );

    this.sonarSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.eip.attrPublicIp + "/32"),
      ec2.Port.tcp(80),
      "Elastic IP - public IPv4Pool"
    );

    const dbCluster = new rds.DatabaseInstance(this, `${id}DatabaseInstance`, {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      databaseName: DB_NAME,
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromGeneratedSecret("dbClusterUsername"),
      port: DB_PORT,
      vpc: props.vpc,
    });

    const cluster = new ecs.Cluster(this, `${id}ECSCluster`, {
      vpc: props.vpc,
    });

    cluster.autoscalingGroup?.addUserData(
      `sysctl -w vm.max_map_count=524288`,
      `sysctl -w fs.file-max=131072`,
      `ulimit -n 131072`,
      `ulimit -u 8192`
    );

    const loadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      `${id}LoadBalancer`,
      {
        vpc: props.vpc,
        internetFacing: true,
        securityGroup: this.sonarSecurityGroup,
      }
    );

    const ecsTaskRole = new iam.Role(this, `${id}TaskRole`, {
      roleName: `${id}TaskRole`,
      assumedBy: new iam.ServicePrincipal(`ecs-tasks.amazonaws.com`),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    });
    dbCluster.secret?.grantRead(ecsTaskRole);

    this.service = new ecsp.ApplicationLoadBalancedFargateService(
      this,
      `${id}SonarQubeServer`,
      {
        cluster,
        desiredCount: 1,
        securityGroups: [this.sonarSecurityGroup],
        taskImageOptions: {
          image: ecs.ContainerImage.fromRegistry("sonarqube:lts-community"),
          containerPort: SONAR_PORT,
          environment: {
            SONAR_CE_JAVAOPTS: "-Xmx1G -Xms1G -XX:+HeapDumpOnOutOfMemoryError",
            SONAR_LOG_LEVEL: "DEBUG",
            SONAR_JDBC_URL: `jdbc:postgresql://${dbCluster.instanceEndpoint.socketAddress}/${DB_NAME}`,
            SONAR_WEB_PORT: `${SONAR_PORT}`,
            ES_SETTING_NODE_STORE_ALLOW__MMAP: "false",
          },
          secrets: {
            SONAR_JDBC_USERNAME: ecs.Secret.fromSecretsManager(
              dbCluster.secret as sm.Secret,
              "username"
            ),
            SONAR_JDBC_PASSWORD: ecs.Secret.fromSecretsManager(
              dbCluster.secret as sm.Secret,
              "password"
            ),
          },
          taskRole: ecsTaskRole,
          command: [
            "-Dsonar.search.javaAdditionalOpts=-Dnode.store.allow_mmap=false",
          ],
        },
        loadBalancer,
        openListener: false,
        memoryLimitMiB: 4096,
        cpu: 1024,
      }
    );

    const sonarAdminSecret = new sm.Secret(this, `${id}AdmSecret`, {
      secretName: `${id}AdmSecret`,
    });

    const sonarServiceAccountSecret = new sm.Secret(
      this,
      `${id}PullRequestValidatorSecret`,
      {
        secretName: `${id}SonarSASecret`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            username: "sonarSVCAUSername",
            name: "Sonar Service Account",
          }),
          generateStringKey: "password",
          excludePunctuation: true,
          passwordLength: 10,
        },
      }
    );

    const lambdaRole = new iam.Role(this, `${id}LambdaRole`, {
      assumedBy: new iam.ServicePrincipal(`lambda.amazonaws.com`),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaVPCAccessExecutionRole"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    const codeBuildRole = new iam.Role(this, `${id}CodeBuildRole`, {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
    });
    sonarServiceAccountSecret.grantRead(codeBuildRole);

    codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "codecommit:UpdatePullRequestApprovalState",
          "codecommit:PostCommentForPullRequest",
        ],
        resources: ["*"],
      })
    );

    this.project = new codebuild.Project(this, `${id}Project`, {
      vpc: props.vpc,
      securityGroups: [this.sonarSecurityGroup],
      badge: true,
      source: codebuild.Source.gitHub({
        owner: "spring-projects",
        repo: "spring-petclinic",
        webhook: true,
      }),
      projectName: `${id}SonarQubeAnalyzeProject`,
      description: "Project description",
      buildSpec: codebuild.BuildSpec.fromSourceFilename("buildspec.yml"),
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromCodeBuildImageId(
          `aws/codebuild/amazonlinux2-x86_64-standard:corretto11`
        ),
        computeType: codebuild.ComputeType.MEDIUM,
      },
      environmentVariables: {
        SONARQUBE_USER_SECRET_NAME: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: sonarServiceAccountSecret.secretName,
        },
        SONARQUBE_HOST_URL: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: `http://${this.service.loadBalancer.loadBalancerDnsName}`,
        },
      },
      role: codeBuildRole,
    });

    const lambdaFunction = new lambdanode.NodejsFunction(
      this,
      `${id}SonarOnboardingFunction`,
      {
        vpc: props.vpc,
        securityGroups: [this.sonarSecurityGroup],
        functionName: `${id}SonarOnboardingFunction`,
        entry: "lambda/sonarqubeOnboarding.lambda.ts",
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(900),
        retryAttempts: 0,
        role: lambdaRole,
        environment: {
          SONAR_URL: "http://" + this.service.loadBalancer.loadBalancerDnsName,
          SONAR_ADMIN_SECRET_ARN: sonarAdminSecret.secretArn,
          SONAR_SERVICE_ACCOUNT_SECRET_ARN: sonarServiceAccountSecret.secretArn,
        },
      }
    );

    sonarAdminSecret.grantRead(lambdaFunction);
    sonarServiceAccountSecret.grantRead(lambdaFunction);

    const parametersAndSecretsExtension =
      lambda.LayerVersion.fromLayerVersionArn(
        this,
        "ParametersAndSecretsLambdaExtension",
        "arn:aws:lambda:eu-west-3:780235371811:layer:AWS-Parameters-and-Secrets-Lambda-Extension:11"
      );
    lambdaFunction.addLayers(parametersAndSecretsExtension);

    const lambdaTrigger = new cr.AwsCustomResource(
      this,
      `${id}StatefunctionTrigger`,
      {
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["lambda:InvokeFunction"],
            effect: iam.Effect.ALLOW,
            resources: [lambdaFunction.functionArn],
          }),
        ]),
        timeout: cdk.Duration.minutes(15),
        onCreate: {
          service: "Lambda",
          action: "invoke",
          parameters: {
            FunctionName: lambdaFunction.functionName,
            InvocationType: triggers.InvocationType.EVENT,
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `${id}LambdaTriggerPhysicalId`
          ),
        },
      }
    );
    lambdaTrigger.node.addDependency(this.service);
  }
}

import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import cdk from 'aws-cdk-lib';
import codebuild from 'aws-cdk-lib/aws-codebuild';
import ec2 from 'aws-cdk-lib/aws-ec2';
import ecs from 'aws-cdk-lib/aws-ecs';
import efs from 'aws-cdk-lib/aws-efs';
import elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import events from 'aws-cdk-lib/aws-events';
import targets from 'aws-cdk-lib/aws-events-targets';
import iam from 'aws-cdk-lib/aws-iam';
import lambda from 'aws-cdk-lib/aws-lambda';
import lambdanode from 'aws-cdk-lib/aws-lambda-nodejs';
import rds from 'aws-cdk-lib/aws-rds';
import sm from 'aws-cdk-lib/aws-secretsmanager';
import cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface SonarQubeProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

export class SonarQube extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly sonarSecurityGroup: ec2.SecurityGroup;
  public readonly project: codebuild.Project;

  constructor(scope: Construct, id: string, props: SonarQubeProps) {
    super(scope, id, props);

    const DB_NAME = `sonarqube`;
    const DB_PORT = 5432;
    const SONAR_PORT = 9000;

    // Security group for SonarQube service
    this.sonarSecurityGroup = new ec2.SecurityGroup(this, `${id}SecurityGroup`, {
      securityGroupName: `${id}SecurityGroup`,
      description: 'Contains ECS cluster and ALB for SonarQube',
      vpc: props.vpc,
      allowAllOutbound: true,
    });

    // Security group for RDS database
    const dbSecurityGroup = new ec2.SecurityGroup(this, `${id}DBSecurityGroup`, {
      securityGroupName: `${id}DBSecurityGroup`,
      description: 'Security group for RDS instance',
      vpc: props.vpc,
      allowAllOutbound: true,
    });

    // Allow SonarQube service to connect to RDS
    dbSecurityGroup.addIngressRule(
      this.sonarSecurityGroup,
      ec2.Port.tcp(DB_PORT),
      'Allow DB connection from SonarQube security group'
    );

    // Allow inbound traffic to SonarQube service
    this.sonarSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(9000),
      'Allow inbound traffic on port 9000 from within the VPC'
    );

    // Create RDS PostgreSQL database
    const dbInstance = new rds.DatabaseInstance(this, `${id}DatabaseInstance`, {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_13,
      }),
      databaseName: DB_NAME,
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromGeneratedSecret('dbClusterUsername'),
      port: DB_PORT,
      vpc: props.vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN in production
      deletionProtection: false,
    });

    // Create ECS cluster
    const cluster = new ecs.Cluster(this, `${id}ECSCluster`, {
      vpc: props.vpc,
    });

    // Security group for EFS
    const efsSecurityGroup = new ec2.SecurityGroup(this, `${id}EfsSecurityGroup`, {
      vpc: props.vpc,
      description: 'Security group for EFS',
      allowAllOutbound: true,
    });

    // Create EFS file system for SonarQube data
    const fileSystem = new efs.FileSystem(this, `${id}EfsFileSystem`, {
      vpc: props.vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN in production
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      securityGroup: efsSecurityGroup,
    });

    // EFS access point
    const accessPoint = new efs.AccessPoint(this, `${id}EfsAccessPoint`, {
      fileSystem,
      path: '/sonarqube',
      posixUser: {
        uid: '1000',
        gid: '1000',
      },
      createAcl: {
        ownerUid: '1000',
        ownerGid: '1000',
        permissions: '755',
      },
    });

    // Allow NFS traffic from ECS tasks to EFS
    efsSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(2049),
      'Allow NFS traffic from VPC'
    );

    // ECS task role
    const ecsTaskRole = new iam.Role(this, `${id}TaskRole`, {
      roleName: `${id}TaskRole`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // ECS execution role
    const ecsExecutionRole = new iam.Role(this, `${id}ExecutionRole`, {
      roleName: `${id}ExecutionRole`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Grant the task role permission to read the database secret
    dbInstance.secret?.grantRead(ecsTaskRole);

    // Create Application Load Balancer
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, `${id}LoadBalancer`, {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: this.sonarSecurityGroup,
    });

    // Create a listener for the ALB
    const listener = this.loadBalancer.addListener(`${id}Listener`, {
      port: 80,
      open: true,
    });

    // Create Fargate Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, `${id}TaskDef`, {
      memoryLimitMiB: 8192,
      cpu: 4096,
      taskRole: ecsTaskRole,
      executionRole: ecsExecutionRole,
    });

    // Add EFS volume to task definition
    const volumeName = 'sonarqube-data';

    taskDefinition.addVolume({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });

    // Add container to task definition
    const container = taskDefinition.addContainer(`${id}Container`, {
      image: ecs.ContainerImage.fromRegistry('sonarqube:lts-community'),
      memoryLimitMiB: 8192,
      cpu: 4096,
      environment: {
        SONAR_CE_JAVAOPTS: '-Xmx1G -Xms1G -XX:+HeapDumpOnOutOfMemoryError',
        SONAR_LOG_LEVEL: 'DEBUG',
        SONAR_JDBC_URL: `jdbc:postgresql://${dbInstance.instanceEndpoint.socketAddress}/${DB_NAME}`,
        SONAR_WEB_PORT: `${SONAR_PORT}`,
        SONAR_SEARCH_JAVAADDITIONALOPTS: '-Dnode.store.allow_mmap=false',
      },
      secrets: {
        SONAR_JDBC_USERNAME: ecs.Secret.fromSecretsManager(dbInstance.secret as sm.ISecret, 'username'),
        SONAR_JDBC_PASSWORD: ecs.Secret.fromSecretsManager(dbInstance.secret as sm.ISecret, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'SonarQube' }),
    });

    // Mount the EFS volume in the container
    container.addMountPoints({
      sourceVolume: volumeName,
      containerPath: '/opt/sonarqube/data',
      readOnly: false,
    });

    // Expose the container port
    container.addPortMappings({
      containerPort: SONAR_PORT,
      protocol: ecs.Protocol.TCP,
    });

    // Create the Fargate service
    this.service = new ecs.FargateService(this, `${id}Service`, {
      cluster,
      taskDefinition,
      desiredCount: 1,
      securityGroups: [this.sonarSecurityGroup],
      assignPublicIp: false,
    });

    // Allow the ECS task to use the EFS file system
    fileSystem.connections.allowDefaultPortFrom(this.service.connections);

    // Ensure the task role can mount the EFS file system
    fileSystem.grant(
      this.service.taskDefinition.taskRole,
      'elasticfilesystem:ClientMount',
      'elasticfilesystem:ClientWrite'
    );

    // Register the service with the ALB listener
    listener.addTargets(`${id}Target`, {
      port: SONAR_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [this.service],
      healthCheck: {
        path: '/api/system/status',
        interval: cdk.Duration.seconds(60),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 10,
      },
    });

    // SonarQube admin secret
    const sonarAdminSecret = new sm.Secret(this, `${id}AdminSecret`, {
      secretName: `${id}AdminSecret`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'admin',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 12,
      },
    });

    // SonarQube Jenkins service account secret
    const sonarJenkinsSecret = new sm.Secret(this, `${id}JenkinsSecret`, {
      secretName: `${id}JenkinsSecret`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'jenkins',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 12,
      },
    });

    // SonarQube CodeBuild service account secret
    const sonarCodeBuildSecret = new sm.Secret(this, `${id}CodeBuildSecret`, {
      secretName: `${id}CodeBuildSecret`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'codebuild',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 12,
      },
    });

    // Lambda role
    const lambdaRole = new iam.Role(this, `${id}LambdaRole`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant Lambda function permissions to read and write secrets
    sonarAdminSecret.grantRead(lambdaRole);
    sonarJenkinsSecret.grantRead(lambdaRole);
    sonarJenkinsSecret.grantWrite(lambdaRole);
    sonarCodeBuildSecret.grantRead(lambdaRole);
    sonarCodeBuildSecret.grantWrite(lambdaRole);

    // Lambda function to automate SonarQube onboarding
    const lambdaFunction = new lambdanode.NodejsFunction(this, `${id}OnboardingFunction`, {
      vpc: props.vpc,
      securityGroups: [this.sonarSecurityGroup],
      functionName: `${id}SonarOnboardingFunction`,
      entry: path.join(__dirname, './lambda/sonarqubeOnboarding.lambda.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.minutes(15),
      retryAttempts: 0,
      role: lambdaRole,
      environment: {
        SONAR_URL: `http://${this.loadBalancer.loadBalancerDnsName}`,
        SONAR_ADMIN_SECRET_ARN: sonarAdminSecret.secretArn,
        SONAR_JENKINS_SECRET_ARN: sonarJenkinsSecret.secretArn,
        SONAR_CODEBUILD_SECRET_ARN: sonarCodeBuildSecret.secretArn,
      },
    });

    // Custom resource to invoke the Lambda function after SonarQube is up
    const lambdaTrigger = new cr.AwsCustomResource(this, `${id}StatefunctionTrigger`, {
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          effect: iam.Effect.ALLOW,
          resources: [lambdaFunction.functionArn],
        }),
      ]),
      timeout: cdk.Duration.minutes(15),
      onCreate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: lambdaFunction.functionName,
          InvocationType: 'RequestResponse',
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${id}LambdaTriggerPhysicalId`),
      },
    });
    lambdaTrigger.node.addDependency(this.service);

    // CodeBuild role
    const codeBuildRole = new iam.Role(this, `${id}CodeBuildRole`, {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    // Grant CodeBuild permissions to read the SonarQube service account secret
    sonarCodeBuildSecret.grantRead(codeBuildRole);

    // CodeBuild project for running SonarQube analysis
    this.project = new codebuild.Project(this, `${id}Project`, {
      vpc: props.vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.sonarSecurityGroup],
      badge: true,
      source: codebuild.Source.gitHub({
        owner: 'spring-projects',
        repo: 'spring-petclinic',
      }),
      projectName: `${id}AnalyzeProject`,
      description: 'CodeBuild project for SonarQube analysis of Petclinic',
      buildSpec: codebuild.BuildSpec.fromAsset(path.join(__dirname, './buildspec.yml')),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_6_0,
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          SONAR_HOST_URL: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: `http://${this.loadBalancer.loadBalancerDnsName}`,
          },
          SONAR_LOGIN_SECRET_NAME: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: sonarCodeBuildSecret.secretName,
          },
        },
      },
      role: codeBuildRole,
    });

    // Trigger CodeBuild project hourly
    new events.Rule(this, `${id}HourlyBuildTrigger`, {
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.CodeBuildProject(this.project)],
    });

    // Output the SonarQube URL
    new cdk.CfnOutput(this, `${id}Url`, {
      value: `http://${this.loadBalancer.loadBalancerDnsName}`,
    });
  }
}

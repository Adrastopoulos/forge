import cdk from 'aws-cdk-lib';
import codebuild from 'aws-cdk-lib/aws-codebuild';
import ec2 from 'aws-cdk-lib/aws-ec2';
import ecs from 'aws-cdk-lib/aws-ecs';
import ecsp from 'aws-cdk-lib/aws-ecs-patterns';
import efs from 'aws-cdk-lib/aws-efs';
import elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import iam from 'aws-cdk-lib/aws-iam';
import lambda from 'aws-cdk-lib/aws-lambda';
import lambdanode from 'aws-cdk-lib/aws-lambda-nodejs';
import rds from 'aws-cdk-lib/aws-rds';
import sm from 'aws-cdk-lib/aws-secretsmanager';
import cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface SonarQubeConstructProps {
  vpc: ec2.IVpc;
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

    // Security group for SonarQube service
    this.sonarSecurityGroup = new ec2.SecurityGroup(this, `${id}SonarSecurityGroup`, {
      securityGroupName: `${id}SonarSecurityGroup`,
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
      'Allow AuroraDB connection from SonarQube security group'
    );

    // Allow inbound traffic to SonarQube service
    this.sonarSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(SONAR_PORT),
      'Allow connection to SonarQube server'
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
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, `${id}LoadBalancer`, {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: this.sonarSecurityGroup,
    });

    // Create SonarQube Fargate service
    this.service = new ecsp.ApplicationLoadBalancedFargateService(this, `${id}SonarQubeServer`, {
      cluster,
      desiredCount: 1,
      securityGroups: [this.sonarSecurityGroup],
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry('sonarqube:lts-community'),
        containerPort: SONAR_PORT,
        environment: {
          SONAR_CE_JAVAOPTS: '-Xmx1G -Xms1G -XX:+HeapDumpOnOutOfMemoryError',
          SONAR_LOG_LEVEL: 'DEBUG',
          SONAR_JDBC_URL: `jdbc:postgresql://${dbInstance.instanceEndpoint.socketAddress}/${DB_NAME}`,
          SONAR_WEB_PORT: `${SONAR_PORT}`,
          ES_SETTING_NODE_STORE_ALLOW__MMAP: 'false',
        },
        secrets: {
          SONAR_JDBC_USERNAME: ecs.Secret.fromSecretsManager(dbInstance.secret as sm.ISecret, 'username'),
          SONAR_JDBC_PASSWORD: ecs.Secret.fromSecretsManager(dbInstance.secret as sm.ISecret, 'password'),
        },
        taskRole: ecsTaskRole,
        executionRole: ecsExecutionRole,
      },
      loadBalancer,
      openListener: true,
      memoryLimitMiB: 8192,
      cpu: 4096,
    });

    // Add EFS volume to task definition
    const volumeName = 'sonarqube-data';

    this.service.taskDefinition.addVolume({
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

    // Mount the EFS volume in the container
    this.service.taskDefinition.defaultContainer?.addMountPoints({
      sourceVolume: volumeName,
      containerPath: '/opt/sonarqube/data',
      readOnly: false,
    });

    // Allow the ECS task to use the EFS file system
    fileSystem.connections.allowDefaultPortFrom(this.service.service.connections);

    // Ensure the task role can mount the EFS file system
    fileSystem.grant(
      this.service.taskDefinition.taskRole,
      'elasticfilesystem:ClientMount',
      'elasticfilesystem:ClientWrite'
    );

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

    // SonarQube service account secret
    const sonarServiceAccountSecret = new sm.Secret(this, `${id}ServiceAccountSecret`, {
      secretName: `${id}ServiceAccountSecret`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'jenkins',
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

    // Grant Lambda function permissions to read secrets
    sonarAdminSecret.grantRead(lambdaRole);
    sonarServiceAccountSecret.grantRead(lambdaRole);

    // Lambda function to automate SonarQube onboarding
    const lambdaFunction = new lambdanode.NodejsFunction(this, `${id}SonarOnboardingFunction`, {
      vpc: props.vpc,
      securityGroups: [this.sonarSecurityGroup],
      functionName: `${id}SonarOnboardingFunction`,
      entry: 'src/lib/lambda/sonarqubeOnboarding.lambda.ts',
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.minutes(15),
      retryAttempts: 0,
      role: lambdaRole,
      environment: {
        SONAR_URL: `http://${this.service.loadBalancer.loadBalancerDnsName}`,
        SONAR_ADMIN_SECRET_ARN: sonarAdminSecret.secretArn,
        SONAR_SERVICE_ACCOUNT_SECRET_ARN: sonarServiceAccountSecret.secretArn,
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
    sonarServiceAccountSecret.grantRead(codeBuildRole);

    // CodeBuild project for running SonarQube analysis
    this.project = new codebuild.Project(this, `${id}Project`, {
      vpc: props.vpc,
      securityGroups: [this.sonarSecurityGroup],
      badge: true,
      source: codebuild.Source.gitHub({
        owner: 'spring-projects',
        repo: 'spring-petclinic',
        webhook: true,
      }),
      projectName: `${id}SonarQubeAnalyzeProject`,
      description: 'CodeBuild project for SonarQube analysis of Petclinic',
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_6_0,
        computeType: codebuild.ComputeType.MEDIUM,
        environmentVariables: {
          SONAR_HOST_URL: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: `http://${this.service.loadBalancer.loadBalancerDnsName}`,
          },
          SONAR_LOGIN_SECRET_NAME: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: sonarServiceAccountSecret.secretName,
          },
        },
      },
      role: codeBuildRole,
    });
  }
}

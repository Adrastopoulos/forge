import type { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecrassets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

const __dirname = new URL('.', import.meta.url).pathname;

export interface JenkinsProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  sonarqubeUrl: string;
  sonarqubeTokenSecret: secretsmanager.ISecret;
}

export class Jenkins extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly jenkinsSecurityGroup: ec2.SecurityGroup;
  public readonly fileSystem: efs.IFileSystem;

  constructor(scope: Construct, id: string, props: JenkinsProps) {
    super(scope, id, props);

    const JENKINS_PORT = 8080;
    const PETCLINIC_PORT = 9090;

    // Create a security group for Jenkins
    this.jenkinsSecurityGroup = new ec2.SecurityGroup(this, `${id}SecurityGroup`, {
      vpc: props.vpc,
      description: 'Security group for Jenkins service',
      allowAllOutbound: true,
    });

    // Allow inbound HTTP traffic on port 80 from anywhere
    this.jenkinsSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP access to Jenkins'
    );

    this.jenkinsSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(PETCLINIC_PORT),
      'Allow PetClinic access'
    );

    // Create an ECS cluster
    const cluster = new ecs.Cluster(this, `${id}Cluster`, {
      vpc: props.vpc,
    });

    // Create task and execution roles
    const taskRole = new iam.Role(this, `${id}TaskRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const executionRole = new iam.Role(this, `${id}ExecutionRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Create a secret for Jenkins admin credentials
    const adminSecret = new secretsmanager.Secret(this, `${id}AdminSecret`, {
      secretName: `${id}AdminSecret`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 16,
      },
    });

    // Grant the task role permissions to read the secrets
    adminSecret.grantRead(taskRole);
    props.sonarqubeTokenSecret.grantRead(taskRole);

    // Create an EFS file system
    const efsSecurityGroup = new ec2.SecurityGroup(this, `${id}EfsSecurityGroup`, {
      vpc: props.vpc,
      description: 'Security group for EFS',
      allowAllOutbound: true,
    });

    this.fileSystem = new efs.FileSystem(this, `${id}EfsFileSystem`, {
      vpc: props.vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN for production
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      securityGroup: efsSecurityGroup,
    });

    // Allow NFS traffic from ECS tasks to EFS
    efsSecurityGroup.addIngressRule(
      this.jenkinsSecurityGroup,
      ec2.Port.tcp(2049),
      'Allow NFS traffic from Jenkins ECS tasks'
    );

    // Create an Access Point
    const accessPoint = new efs.AccessPoint(this, `${id}EfsAccessPoint`, {
      fileSystem: this.fileSystem,
      path: '/jenkins',
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

    // Create a Fargate Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, `${id}TaskDef`, {
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
      memoryLimitMiB: 4096,
      cpu: 1024,
      taskRole,
      executionRole,
    });

    const asset = new ecrassets.DockerImageAsset(this, `${id}DockerImage`, {
      directory: `${__dirname}/../../docker/jenkins/`,
      platform: ecrassets.Platform.LINUX_AMD64,
    });
    const image = ecs.ContainerImage.fromDockerImageAsset(asset);

    // Add Jenkins container to the task definition
    const container = taskDefinition.addContainer(`${id}Container`, {
      image,
      containerName: 'jenkins',
      environment: {
        JAVA_OPTS: '-Djenkins.install.runSetupWizard=false',
        SONAR_HOST_URL: props.sonarqubeUrl,
        CASC_JENKINS_CONFIG: '/usr/share/jenkins/ref/jenkins.yaml',
      },
      secrets: {
        JENKINS_ADMIN_USERNAME: ecs.Secret.fromSecretsManager(adminSecret, 'username'),
        JENKINS_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminSecret, 'password'),
        SONAR_TOKEN: ecs.Secret.fromSecretsManager(props.sonarqubeTokenSecret, 'token'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'Jenkins',
      }),
      portMappings: [
        {
          containerPort: JENKINS_PORT,
          protocol: ecs.Protocol.TCP,
        },
      ],
    });

    // Mount the EFS volume in the container
    taskDefinition.addVolume({
      name: 'jenkins-home',
      efsVolumeConfiguration: {
        fileSystemId: this.fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: 'ENABLED',
        },
      },
    });

    container.addMountPoints({
      sourceVolume: 'jenkins-home',
      containerPath: '/var/jenkins_home',
      readOnly: false,
    });

    // Create the Fargate service
    this.service = new ecs.FargateService(this, `${id}Service`, {
      cluster,
      taskDefinition,
      desiredCount: 2,
      securityGroups: [this.jenkinsSecurityGroup],
      assignPublicIp: true,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // Allow the ECS task to use the EFS file system
    this.fileSystem.connections.allowDefaultPortFrom(this.service.connections);

    // Ensure the task role can mount the EFS file system
    this.fileSystem.grant(taskRole, 'elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite');

    // Create an Application Load Balancer
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, `${id}LB`, {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: this.jenkinsSecurityGroup,
    });

    // Create a listener on the ALB
    const listener = this.loadBalancer.addListener(`${id}Listener`, {
      port: 80,
      open: true,
    });

    // Add the service as a target of the listener
    listener.addTargets(`${id}TargetGroup`, {
      port: JENKINS_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        this.service.loadBalancerTarget({
          containerName: 'jenkins',
          containerPort: JENKINS_PORT,
        }),
      ],
      healthCheck: {
        path: '/login', // Adjust the health check path as needed
        interval: cdk.Duration.seconds(60),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
    });

    // Add PetClinic container to the same task definition
    const petclinicContainer = taskDefinition.addContainer('PetClinicContainer', {
      image: ecs.ContainerImage.fromRegistry('eclipse-temurin:17-jdk-jammy'), // Base Java image
      containerName: 'petclinic',
      essential: false, // So Jenkins container remains primary
      command: [
        'sh',
        '-c',
        'while [ ! -f /var/jenkins_home/workspace/Build-Petclinic/target/*.jar ]; do sleep 10; done; java -jar /var/jenkins_home/workspace/Build-Petclinic/target/*.jar --server.port=9090',
      ],
      portMappings: [
        {
          containerPort: 9090,
          protocol: ecs.Protocol.TCP,
        },
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'PetClinic',
      }),
    });

    // Share Jenkins home volume with PetClinic container
    petclinicContainer.addMountPoints({
      sourceVolume: 'jenkins-home',
      containerPath: '/var/jenkins_home',
      readOnly: true,
    });

    // Create a listener for PetClinic on the ALB
    const petclinicListener = this.loadBalancer.addListener(`${id}PetclinicListener`, {
      port: PETCLINIC_PORT,
      open: true,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    // Add PetClinic target
    petclinicListener.addTargets(`${id}PetclinicTargetGroup`, {
      port: PETCLINIC_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [
        this.service.loadBalancerTarget({
          containerName: 'petclinic',
          containerPort: PETCLINIC_PORT,
          protocol: ecs.Protocol.TCP,
        }),
      ],
      healthCheck: {
        path: '/',
        interval: cdk.Duration.seconds(60),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
      },
    });

    new cdk.CfnOutput(this, `${id}Url`, {
      value: `http://${this.loadBalancer.loadBalancerDnsName}`,
    });

    new cdk.CfnOutput(this, `${id}PetClinicUrl`, {
      value: `http://${this.loadBalancer.loadBalancerDnsName}:${PETCLINIC_PORT}`,
    });
  }
}

import cdk from 'aws-cdk-lib';
import ec2 from 'aws-cdk-lib/aws-ec2';
import ecs from 'aws-cdk-lib/aws-ecs';
import efs from 'aws-cdk-lib/aws-efs';
import elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import iam from 'aws-cdk-lib/aws-iam';
import secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface JenkinsConstructProps {
  vpc: ec2.IVpc;
}

export class JenkinsConstruct extends Construct {
  public readonly service: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly jenkinsSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: JenkinsConstructProps) {
    super(scope, id);

    const JENKINS_PORT = 8080;

    // Create a security group for Jenkins
    this.jenkinsSecurityGroup = new ec2.SecurityGroup(this, `${id}JenkinsSecurityGroup`, {
      vpc: props.vpc,
      description: 'Security group for Jenkins service',
      allowAllOutbound: true,
    });

    // Allow inbound traffic on Jenkins port from anywhere
    this.jenkinsSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(JENKINS_PORT),
      'Allow Jenkins web access'
    );

    // Create an ECS cluster
    const cluster = new ecs.Cluster(this, `${id}JenkinsCluster`, {
      vpc: props.vpc,
    });

    // Create task and execution roles
    const taskRole = new iam.Role(this, `${id}JenkinsTaskRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const executionRole = new iam.Role(this, `${id}JenkinsExecutionRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Create a secret for Jenkins configuration
    const configContent = `
jenkins:
  systemMessage: "Jenkins configured automatically by Configuration as Code plugin"
  numExecutors: 2

installPlugins:
  - blueocean:latest
  - git:latest
  - workflow-aggregator:latest
  - configuration-as-code:latest
  - sonar:latest
`;

    const base64ConfigContent = cdk.Fn.base64(configContent);

    const configSecret = new secretsmanager.Secret(this, `${id}JenkinsConfigSecret`, {
      secretStringValue: cdk.SecretValue.unsafePlainText(base64ConfigContent),
    });

    // Grant the task role permissions to read the secret
    configSecret.grantRead(taskRole);

    // Create an EFS file system
    const efsSecurityGroup = new ec2.SecurityGroup(this, `${id}EfsSecurityGroup`, {
      vpc: props.vpc,
      description: 'Security group for EFS',
      allowAllOutbound: true,
    });

    const fileSystem = new efs.FileSystem(this, `${id}EfsFileSystem`, {
      vpc: props.vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN for production
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      securityGroup: efsSecurityGroup,
    });

    // Allow NFS traffic from ECS tasks to EFS
    efsSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(2049),
      'Allow NFS traffic from VPC'
    );

    // Create an Access Point
    const accessPoint = new efs.AccessPoint(this, `${id}EfsAccessPoint`, {
      fileSystem,
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
      memoryLimitMiB: 4096,
      cpu: 1024,
      taskRole,
      executionRole,
      volumes: [
        {
          name: 'jenkins-home',
          efsVolumeConfiguration: {
            fileSystemId: fileSystem.fileSystemId,
            transitEncryption: 'ENABLED',
            authorizationConfig: {
              accessPointId: accessPoint.accessPointId,
              iam: 'ENABLED',
            },
          },
        },
      ],
    });

    // Add Jenkins container to the task definition
    const container = taskDefinition.addContainer(`${id}JenkinsContainer`, {
      image: ecs.ContainerImage.fromRegistry('jenkins/jenkins:lts-jdk11'),
      containerName: 'jenkins',
      environment: {
        JAVA_OPTS: '-Djenkins.install.runSetupWizard=false',
      },
      secrets: {
        CASC_JENKINS_CONFIG_BASE64: ecs.Secret.fromSecretsManager(configSecret),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'Jenkins' }),
    });

    container.addPortMappings({
      containerPort: JENKINS_PORT,
      protocol: ecs.Protocol.TCP,
    });

    // Mount the EFS volume in the container
    container.addMountPoints({
      sourceVolume: 'jenkins-home',
      containerPath: '/var/jenkins_home',
      readOnly: false,
    });

    // Create the Fargate service
    this.service = new ecs.FargateService(this, `${id}JenkinsService`, {
      cluster,
      taskDefinition,
      desiredCount: 1,
      securityGroups: [this.jenkinsSecurityGroup],
      assignPublicIp: false,
    });

    // Allow the ECS task to use the EFS file system
    fileSystem.connections.allowDefaultPortFrom(this.service.connections);

    // Ensure the task role can mount the EFS file system
    fileSystem.grant(taskRole, 'elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite');

    // Create an Application Load Balancer
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, `${id}JenkinsLB`, {
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

    // Output the Load Balancer DNS
    new cdk.CfnOutput(this, `${id}LoadBalancerDNS`, {
      value: this.loadBalancer.loadBalancerDnsName,
    });
  }
}

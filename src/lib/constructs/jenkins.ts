import cdk from 'aws-cdk-lib';
import ec2 from 'aws-cdk-lib/aws-ec2';
import ecs from 'aws-cdk-lib/aws-ecs';
import ecsp from 'aws-cdk-lib/aws-ecs-patterns';
import efs from 'aws-cdk-lib/aws-efs';
import elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import iam from 'aws-cdk-lib/aws-iam';
import secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface JenkinsConstructProps {
  vpc: ec2.IVpc;
}

export class JenkinsConstruct extends Construct {
  public readonly service: ecsp.ApplicationLoadBalancedFargateService;
  public readonly jenkinsSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: JenkinsConstructProps) {
    super(scope, id);

    const JENKINS_PORT = 8080;

    this.jenkinsSecurityGroup = new ec2.SecurityGroup(this, `${id}JenkinsSecurityGroup`, {
      vpc: props.vpc,
      description: 'Security group for Jenkins service',
      allowAllOutbound: true,
    });

    // Create an ECS cluster
    const cluster = new ecs.Cluster(this, `${id}JenkinsCluster`, {
      vpc: props.vpc,
    });

    // Create a task role
    const taskRole = new iam.Role(this, `${id}JenkinsTaskRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Create an execution role and attach the AmazonECSTaskExecutionRolePolicy
    const executionRole = new iam.Role(this, `${id}JenkinsExecutionRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Create an Application Load Balancer
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, `${id}JenkinsLB`, {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: this.jenkinsSecurityGroup,
    });

    // Add Jenkins port to security group
    this.jenkinsSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(JENKINS_PORT),
      'Allow Jenkins web access'
    );

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

    // Security group for EFS
    const efsSecurityGroup = new ec2.SecurityGroup(this, `${id}EfsSecurityGroup`, {
      vpc: props.vpc,
      description: 'Security group for EFS',
      allowAllOutbound: true,
    });

    // Create an EFS file system
    const fileSystem = new efs.FileSystem(this, `${id}EfsFileSystem`, {
      vpc: props.vpc,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN for production
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      securityGroup: efsSecurityGroup,
    });

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

    // Allow NFS traffic from ECS tasks to EFS
    efsSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.tcp(2049),
      'Allow NFS traffic from VPC'
    );

    // Allow ECS tasks to connect to EFS
    this.service = new ecsp.ApplicationLoadBalancedFargateService(this, `${id}JenkinsService`, {
      cluster,
      desiredCount: 1,
      securityGroups: [this.jenkinsSecurityGroup],
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry('jenkins/jenkins:lts-jdk11'),
        containerPort: JENKINS_PORT,
        environment: {
          JAVA_OPTS: '-Djenkins.install.runSetupWizard=false',
        },
        secrets: {
          CASC_JENKINS_CONFIG_BASE64: ecs.Secret.fromSecretsManager(configSecret),
        },
        taskRole,
        executionRole,
      },
      loadBalancer,
      openListener: true,
      memoryLimitMiB: 4096,
      cpu: 1024,
    });

    // Add EFS volume to task definition
    const volumeName = 'jenkins-home';

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
      containerPath: '/var/jenkins_home',
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
  }
}

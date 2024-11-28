import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface JenkinsStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  sonarQubeUrl: string;
}

export class JenkinsStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly jenkinsSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: JenkinsStackProps) {
    super(scope, id, props);

    const JENKINS_PORT = 8080;

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

    // Create a secret for SonarQube token
    const sonarqubeTokenSecret = new secretsmanager.Secret(this, `${id}SonarQubeTokenSecret`, {
      secretName: `${id}SonarQubeTokenSecret`,
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'token',
        excludePunctuation: false,
        passwordLength: 32,
      },
    });

    // Grant the task role permissions to read the secrets
    adminSecret.grantRead(taskRole);
    sonarqubeTokenSecret.grantRead(taskRole);

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
      this.jenkinsSecurityGroup,
      ec2.Port.tcp(2049),
      'Allow NFS traffic from Jenkins ECS tasks'
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

    // Jenkins Configuration as Code (CasC) content with inline pipeline script
    const configContent = `
    jenkins:
      systemMessage: "Jenkins configured automatically by Configuration as Code plugin"
      numExecutors: 2
      securityRealm:
        local:
          allowsSignup: false
          users:
            - id: "\${JENKINS_ADMIN_USERNAME}"
              password: "\${JENKINS_ADMIN_PASSWORD}"
      authorizationStrategy:
        loggedInUsersCanDoAnything:
          allowAnonymousRead: false
    unclassified:
      location:
        url: "http://localhost/"
    installState:
      state: "RUNNING"
    tool:
      git:
        installations:
          - name: "Default"
            home: "/usr/bin/git"
    jobs:
      - script: >
          pipelineJob('Build-Petclinic') {
            definition {
              cps {
                script("""
                  pipeline {
                      agent any
                      stages {
                          stage('Checkout') {
                              steps {
                                  git url: 'https://github.com/spring-projects/spring-petclinic.git', branch: 'main'
                              }
                          }
                          stage('Build') {
                              steps {
                                  sh './mvnw clean package'
                              }
                          }
                          stage('SonarQube Analysis') {
                              environment {
                                  SONAR_HOST_URL = '\${SONAR_HOST_URL}'
                              }
                              steps {
                                  withCredentials([string(credentialsId: 'sonarqube-token', variable: 'SONAR_LOGIN')]) {
                                      sh './mvnw sonar:sonar -Dsonar.projectKey=spring-petclinic -Dsonar.host.url=$SONAR_HOST_URL -Dsonar.login=$SONAR_LOGIN'
                                  }
                              }
                          }
                      }
                  }
                """)
                sandbox()
              }
            }
          }
    credentials:
      system:
        domainCredentials:
          - credentials:
              - string:
                  scope: GLOBAL
                  id: 'sonarqube-token'
                  description: 'SonarQube token'
                  secret: "\${SONARQUBE_TOKEN}"
    installPlugins:
      - blueocean:latest
      - git:latest
      - workflow-aggregator:latest
      - configuration-as-code:latest
      - sonar:latest
      - pipeline-github-lib:latest
      - github:latest
      - workflow-multibranch:latest
      - workflow-cps:latest
    `;

    // Escape special characters in configContent
    const escapedConfigContent = configContent
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$/g, '\\$')
      .replace(/"/g, '\\"');

    // Create a Fargate Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, `${id}TaskDef`, {
      memoryLimitMiB: 4096,
      cpu: 1024,
      taskRole,
      executionRole,
    });

    // Add Jenkins container to the task definition
    const container = taskDefinition.addContainer(`${id}Container`, {
      image: ecs.ContainerImage.fromRegistry('jenkins/jenkins:lts'),
      containerName: 'jenkins',
      environment: {
        JAVA_OPTS: '-Djenkins.install.runSetupWizard=false',
        SONAR_HOST_URL: props.sonarQubeUrl,
      },
      secrets: {
        JENKINS_ADMIN_USERNAME: ecs.Secret.fromSecretsManager(adminSecret, 'username'),
        JENKINS_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminSecret, 'password'),
        SONARQUBE_TOKEN: ecs.Secret.fromSecretsManager(sonarqubeTokenSecret, 'token'),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'Jenkins' }),
      entryPoint: ['/bin/sh', '-c'],
      command: [
        `
        mkdir -p /var/jenkins_home/casc_configs && \
        echo "${escapedConfigContent}" > /var/jenkins_home/casc_configs/jenkins.yaml && \
        jenkins-plugin-cli --plugins "configuration-as-code:latest git:latest blueocean:latest sonar:latest pipeline-github-lib:latest github:latest workflow-aggregator:latest workflow-multibranch:latest workflow-cps:latest" && \
        /usr/bin/tini -- /usr/local/bin/jenkins.sh
        `,
      ],
    });

    container.addPortMappings({
      containerPort: JENKINS_PORT,
      protocol: ecs.Protocol.TCP,
    });

    // Mount the EFS volume in the container
    taskDefinition.addVolume({
      name: 'jenkins-home',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
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
      desiredCount: 1,
      securityGroups: [this.jenkinsSecurityGroup],
      assignPublicIp: true,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // Allow the ECS task to use the EFS file system
    fileSystem.connections.allowDefaultPortFrom(this.service.connections);

    // Ensure the task role can mount the EFS file system
    fileSystem.grant(taskRole, 'elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite');

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

    // Output the Jenkins URL
    new cdk.CfnOutput(this, `${id}Url`, {
      value: `http://${this.loadBalancer.loadBalancerDnsName}`,
    });
  }
}

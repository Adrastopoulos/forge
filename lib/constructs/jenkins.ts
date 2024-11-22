import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as ecsp from "aws-cdk-lib/aws-ecs-patterns";
import { Construct } from "constructs";

export interface JenkinsConstructProps {
  vpc: ec2.IVpc;
  securityGroup: ec2.SecurityGroup;
}

export class JenkinsConstruct extends Construct {
  public readonly service: ecsp.ApplicationLoadBalancedFargateService;

  constructor(scope: Construct, id: string, props: JenkinsConstructProps) {
    super(scope, id);

    const JENKINS_PORT = 8080;
    const cluster = new ecs.Cluster(this, `${id}JenkinsCluster`, {
      vpc: props.vpc,
    });

    const taskRole = new iam.Role(this, `${id}JenkinsTaskRole`, {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    });

    const loadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      `${id}JenkinsLB`,
      {
        vpc: props.vpc,
        internetFacing: true,
        securityGroup: props.securityGroup,
      }
    );

    // Add Jenkins port to security group
    props.securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(JENKINS_PORT),
      "Allow Jenkins web access"
    );

    this.service = new ecsp.ApplicationLoadBalancedFargateService(
      this,
      `${id}JenkinsService`,
      {
        cluster,
        desiredCount: 1,
        securityGroups: [props.securityGroup],
        taskImageOptions: {
          image: ecs.ContainerImage.fromRegistry("jenkins/jenkins:lts-jdk11"),
          containerPort: JENKINS_PORT,
          environment: {
            JAVA_OPTS: "-Djenkins.install.runSetupWizard=false",
            CASC_JENKINS_CONFIG: "/var/jenkins_home/casc.yaml",
          },
          taskRole,
        },
        loadBalancer,
        openListener: false,
        memoryLimitMiB: 4096,
        cpu: 1024,
      }
    );

    // Add Blue Ocean and required plugins using Configuration as Code
    const userData =
      this.service.taskDefinition.defaultContainer?.addVolumesFrom({
        name: "jenkins-config",
        containerPath: "/var/jenkins_home/casc.yaml",
        readOnly: true,
        stringContent: `
jenkins:
  systemMessage: "Jenkins configured automatically by Configuration as Code plugin"
  numExecutors: 2
  
installPlugins:
  - blueocean:latest
  - git:latest
  - workflow-aggregator:latest
  - configuration-as-code:latest
  - sonar:latest
`,
      });

    // Optional: Add persistent volume for Jenkins data
    const volumeName = "jenkins-data";
    this.service.taskDefinition.addVolume({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: "YOUR_EFS_ID", // You'll need to create this separately
      },
    });
  }
}

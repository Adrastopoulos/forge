import type { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';

interface ProductionServerProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

export class WebServer extends cdk.Stack {
  public readonly instance: ec2.Instance;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly keyPair: ec2.KeyPair;

  constructor(scope: Construct, id: string, props: ProductionServerProps) {
    super(scope, id, props);

    this.securityGroup = new ec2.SecurityGroup(this, `${id}SG`, {
      vpc: props.vpc,
      description: 'Security group for Production Web Server',
      allowAllOutbound: true,
    });

    this.securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), 'Allow HTTP access');
    this.securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH access');

    const role = new iam.Role(this, `${id}InstanceRole`, {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'yum update -y', // Update the package manager
      'amazon-linux-extras enable corretto17', // Enable Amazon Corretto 17 repository
      'yum install -y java-17-amazon-corretto', // Install Amazon Corretto 17
      'mkdir -p /opt/petclinic', // Create the directory for Petclinic
      'chown ec2-user:ec2-user /opt/petclinic', // Set correct permissions for the directory
      'chmod 755 /opt/petclinic', // Ensure proper permissions for the directory
      'touch /opt/petclinic/petclinic.log', // Create the log file
      'chown ec2-user:ec2-user /opt/petclinic/petclinic.log', // Set correct ownership for the log file
      'chmod 644 /opt/petclinic/petclinic.log' // Ensure the log file has proper permissions
    );

    this.keyPair = new ec2.KeyPair(this, `${id}KeyPair`, {
      keyPairName: `${id}KeyPair`,
      type: ec2.KeyPairType.RSA,
    });

    this.instance = new ec2.Instance(this, `${id}Server`, {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      securityGroup: this.securityGroup,
      role,
      userData,
      keyPair: this.keyPair,
    });

    new cdk.CfnOutput(this, `${id}ServerPublicIp`, {
      value: this.instance.instancePublicIp,
      description: 'Public IP of the production web server',
    });
  }
}

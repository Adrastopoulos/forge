import type { Construct } from 'constructs';
import cdk from 'aws-cdk-lib';
import ec2 from 'aws-cdk-lib/aws-ec2';

export class Forge extends cdk.Stack {
  public vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, `${id}Vpc`, {
      vpcName: `${id}Vpc`,
      natGateways: 1,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      subnetConfiguration: [
        { cidrMask: 20, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 20, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });
  }
}

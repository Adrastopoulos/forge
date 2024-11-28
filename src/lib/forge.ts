import cdk from 'aws-cdk-lib';
import ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class Forge extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly eip: ec2.CfnEIP;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.eip = new ec2.CfnEIP(this, `${id}ElasticIp`);

    this.vpc = new ec2.Vpc(this, `${id}Vpc`, {
      vpcName: `${id}Vpc`,
      natGatewayProvider: ec2.NatProvider.gateway({
        eipAllocationIds: [this.eip.attrAllocationId],
      }),
      natGateways: 1,
    });
  }
}

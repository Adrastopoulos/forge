import cdk from 'aws-cdk-lib';
import ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

import { JenkinsConstruct } from './constructs/jenkins';
import { SonarQubeConstruct } from './constructs/sonarqube';

export class CiForgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const eip = new ec2.CfnEIP(this, `${id}ElasticIp`);

    const vpc = new ec2.Vpc(this, `${id}Vpc`, {
      vpcName: `${id}Vpc`,
      natGatewayProvider: ec2.NatProvider.gateway({
        eipAllocationIds: [eip.attrAllocationId],
      }),
      natGateways: 1,
    });

    const sonarqube = new SonarQubeConstruct(this, `${id}Sonarqube`, {
      vpc,
    });

    const jenkins = new JenkinsConstruct(this, `${id}Jenkins`, {
      vpc,
    });

    sonarqube.sonarSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(jenkins.jenkinsSecurityGroup.securityGroupId),
      ec2.Port.tcp(9000),
      'Allow Jenkins to communicate with SonarQube'
    );

    new cdk.CfnOutput(this, `${id}SonarQubeUrl`, {
      value: `http://${sonarqube.loadBalancer.loadBalancerDnsName}:9000`,
    });

    new cdk.CfnOutput(this, `${id}JenkinsUrl`, {
      value: `http://${jenkins.loadBalancer.loadBalancerDnsName}:80`,
    });
  }
}

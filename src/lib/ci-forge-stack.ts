import cdk from 'aws-cdk-lib';
import ec2 from 'aws-cdk-lib/aws-ec2';
import ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

import { JenkinsConstruct } from './constructs/jenkins';
import { SonarQubeConstruct } from './constructs/sonarqube';

export class CiForgeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create EIP for NAT Gateway
    const eip = new ec2.CfnEIP(this, `${id}ElasticIp`);

    // Create VPC
    const vpc = new ec2.Vpc(this, `${id}Vpc`, {
      vpcName: `${id}Vpc`,
      natGatewayProvider: ec2.NatProvider.gateway({
        eipAllocationIds: [eip.attrAllocationId],
      }),
      natGateways: 1,
    });

    // Create SonarQube
    const sonarqube = new SonarQubeConstruct(this, `${id}Sonarqube`, {
      vpc,
    });

    // Create Jenkins
    const jenkins = new JenkinsConstruct(this, `${id}Jenkins`, {
      vpc,
    });

    sonarqube.sonarSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(jenkins.jenkinsSecurityGroup.securityGroupId),
      ec2.Port.tcp(9000),
      'Allow Jenkins to communicate with SonarQube'
    );

    // Add outputs
    new cdk.CfnOutput(this, `${id}SonarQubeUrl`, {
      value: `http://${sonarqube.service.loadBalancer.loadBalancerDnsName}:9000`,
    });

    new cdk.CfnOutput(this, `${id}JenkinsUrl`, {
      value: `http://${jenkins.service.loadBalancer.loadBalancerDnsName}:8080`,
    });
  }
}
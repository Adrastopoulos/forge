#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { Forge as ForgeStack } from "../lib/forge";

import { SonarQubeStack } from "../lib/sonarqube";
import { JenkinsStack } from "../lib/jenkins";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
}

const forgeStack = new ForgeStack(app, "ForgeStack", {
  env
});

const sonarqube = new SonarQubeStack(app, "SonarQube", {
  env,
  vpc: forgeStack.vpc,
});

const jenkins = new JenkinsStack(app, "Jenkins", {
  env,
  vpc: forgeStack.vpc,
  sonarQubeUrl: sonarqube.loadBalancer.loadBalancerDnsName,
});


#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { Forge as ForgeStack } from "../lib/forge";

import { SonarQube } from "../lib/sonarqube";
import { Jenkins } from "../lib/jenkins";
import { WebServer } from "../lib/webserver";

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
}

const forgeStack = new ForgeStack(app, "ForgeStack", {
  env
});

const sonarqube = new SonarQube(app, "SonarQube", {
  env,
  vpc: forgeStack.vpc,
});

const webserver = new WebServer(app, "WebServer", {
  env,
  vpc: forgeStack.vpc,
})

const jenkins = new Jenkins(app, "Jenkins", {
  env,
  vpc: forgeStack.vpc,
  sonarqubeUrl: `http://${sonarqube.loadBalancer.loadBalancerDnsName}`,
  sonarqubeTokenSecret: sonarqube.sonarJenkinsSecret,
  webServerKeyPair: webserver.keyPair,
  webServerIp: webserver.instance.instancePublicIp,
});

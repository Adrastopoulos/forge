#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CiForgeStack } from "../lib/ciForgeStack";

const app = new cdk.App();
new CiForgeStack(app, "CiForgeStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

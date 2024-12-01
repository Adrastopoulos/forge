# AWS CDK Jenkins and SonarQube Setup

This repository contains AWS CDK code for setting up a Continuous Integration/Continuous Deployment (CI/CD) environment using Jenkins and SonarQube on AWS. The infrastructure is provisioned using AWS CDK in TypeScript and includes the following components:

- **VPC Stack (`lib/forge.ts`)**: Sets up the networking environment.
- **Jenkins Stack (`lib/jenkins.ts`)**: Deploys Jenkins using AWS Fargate.
- **SonarQube Stack (`lib/sonarqube.ts`)**: Deploys SonarQube using AWS Fargate.

---

## Table of Contents

- [AWS CDK Jenkins and SonarQube Setup](#aws-cdk-jenkins-and-sonarqube-setup)
  - [Table of Contents](#table-of-contents)
  - [Architecture Overview](#architecture-overview)
  - [Prerequisites](#prerequisites)
  - [Setup Instructions](#setup-instructions)
    - [1. Clone the Repository](#1-clone-the-repository)
    - [2. Install Dependencies](#2-install-dependencies)
    - [3. Bootstrap the CDK Environment](#3-bootstrap-the-cdk-environment)
    - [4. Deploy the VPC Stack](#4-deploy-the-vpc-stack)
    - [5. Deploy the SonarQube Stack](#5-deploy-the-sonarqube-stack)
    - [6. Deploy the Jenkins Stack](#6-deploy-the-jenkins-stack)
    - [7. Access Jenkins and SonarQube](#7-access-jenkins-and-sonarqube)
    - [8. Execute the Pipeline](#8-execute-the-pipeline)
  - [Provisioning Scripts](#provisioning-scripts)
  - [Automated Scripts](#automated-scripts)
  - [References](#references)

---

## Architecture Overview

The CDK stacks provision the following AWS resources:

- **VPC with Public and Private Subnets**: Enables networking for ECS tasks and load balancers.
- **ECS Cluster**: Hosts Jenkins and SonarQube services using AWS Fargate.
- **EFS File System**: Provides persistent storage for Jenkins data.
- **Application Load Balancers (ALBs)**: Allow access to Jenkins and SonarQube over HTTP.
- **NAT Gateway**: Provides internet access for ECS tasks in private subnets.
- **Secrets Manager**: Stores sensitive information like admin credentials and tokens.

---

## Prerequisites

- **AWS Account**: With permissions to create VPCs, ECS clusters, EFS, and other resources.
- **AWS CLI**: Installed and configured with your AWS credentials.
- **AWS CDK**: Installed globally (`npm install -g aws-cdk`).
- **Node.js and NPM**: For CDK and TypeScript development.
- **Git**: To clone the repository.

---

## Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/Adrastopoulos/forge
cd forge
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Bootstrap the CDK Environment

If you haven't bootstrapped your AWS environment for CDK, run:

```bash
cdk bootstrap
```

### 4. Deploy the VPC Stack

**Stack File**: `src/lib/forge.ts`

This stack sets up the VPC with the necessary networking components.

```bash
cdk deploy ForgeStack
```

### 5. Deploy the SonarQube Stack

**Stack File**: `src/lib/sonarqube.ts`

Before deploying, ensure that the `sonarqube-stack.ts` file references the VPC created in the previous step.

```bash
cdk deploy SonarQube
```

### 6. Deploy the Jenkins Stack

**Stack File**: `lib/jenkins.ts`

Update the `jenkins.ts` file to include the SonarQube URL output from the previous deployment.

```bash
cdk deploy Jenkins
```

### 7. Access Jenkins and SonarQube

- **Jenkins**:
  - **URL**: Outputted after deploying `Jenkins`.
  - **Credentials**: Retrieve the admin username and password from AWS Secrets Manager (`JenkinsAdminSecret`).
- **SonarQube**:
  - **URL**: Outputted after deploying `SonarQube`.
  - **Credentials**: Default (`admin` / `admin`), you will be prompted to change the password on first login.

### 8. Execute the Pipeline

1. **Log into Jenkins** using the credentials from Secrets Manager.
2. **Verify the Pipeline Job**:
   - The `Build-Petclinic` pipeline job should be pre-configured via Jenkins CasC.
3. **Run the Pipeline**:
   - Navigate to the job and click **"Build Now"**.
4. **Monitor the Build**:
   - View the console output to ensure that the code is checked out, built, and analyzed by SonarQube.
5. **Access Petclinic Application** (Optional):
   - If the pipeline deploys the application, access it using the appropriate URL.

---

## Provisioning Scripts

The provisioning of Jenkins and SonarQube is automated using AWS CDK stacks:

- **`src/lib/forge.ts`**: Provisions the VPC and networking components.
- **`src/lib/sonarqube.ts`**: Sets up SonarQube as an ECS Fargate service.
- **`src/lib/jenkins.ts`**: Sets up Jenkins as an ECS Fargate service, including CasC configuration.

---

## Automated Scripts

- **AWS CDK Scripts**: The `cdk` commands automate the deployment of infrastructure.
- **Jenkins CasC**: Jenkins Configuration as Code automates the setup of Jenkins, including plugins, credentials, and jobs.

---

## References

- **Spring Petclinic Repository**: [https://github.com/spring-projects/spring-petclinic](https://github.com/spring-projects/spring-petclinic)
- **AWS CDK Documentation**: [https://docs.aws.amazon.com/cdk/v2/guide/home.html](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
- **Jenkins Official Docker Image**: [https://hub.docker.com/r/jenkins/jenkins](https://hub.docker.com/r/jenkins/jenkins)
- **SonarQube Official Docker Image**: [https://hub.docker.com/\_/sonarqube](https://hub.docker.com/_/sonarqube)
- **Jenkins Configuration as Code (CasC)**: [https://plugins.jenkins.io/configuration-as-code/](https://plugins.jenkins.io/configuration-as-code/)

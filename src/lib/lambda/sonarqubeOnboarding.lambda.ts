import * as AWS from 'aws-sdk';
import axios from 'axios';
import qs from 'qs';

const sm = new AWS.SecretsManager();

export const handler = async (): Promise<void> => {
  const sonarUrl = process.env.SONAR_URL;
  const adminSecretArn = process.env.SONAR_ADMIN_SECRET_ARN;
  const jenkinsSecretArn = process.env.SONAR_JENKINS_SECRET_ARN;
  const codeBuildSecretArn = process.env.SONAR_CODEBUILD_SECRET_ARN;

  if (!sonarUrl || !adminSecretArn || !jenkinsSecretArn || !codeBuildSecretArn) {
    throw new Error(
      'Environment variables SONAR_URL, SONAR_ADMIN_SECRET_ARN, SONAR_JENKINS_SECRET_ARN, and SONAR_CODEBUILD_SECRET_ARN must be set'
    );
  }

  // Retrieve admin credentials
  const adminSecret = await sm.getSecretValue({ SecretId: adminSecretArn }).promise();
  const adminCredentials = JSON.parse(adminSecret.SecretString || '{}');

  // Authenticate as admin
  const adminAuth = {
    username: adminCredentials.username,
    password: adminCredentials.password,
  };

  // Wait for SonarQube to be up
  await waitForSonarQube(sonarUrl);

  // Process Jenkins service account
  await processServiceAccount(sonarUrl, adminAuth, jenkinsSecretArn);

  // Process CodeBuild service account
  await processServiceAccount(sonarUrl, adminAuth, codeBuildSecretArn);

  console.log('Service accounts processed successfully.');
};

const waitForSonarQube = async (sonarUrl: string): Promise<void> => {
  console.log('Waiting for SonarQube to be available...');
  const maxAttempts = 30;
  const delay = 10000; // 10 seconds

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await axios.get(`${sonarUrl}/api/system/status`);
      if (response.data.status === 'UP') {
        console.log('SonarQube is available');
        return;
      }
      console.log('SonarQube is not fully up yet. Retrying...');
    } catch (error) {
      console.log(`SonarQube not available yet. Retrying in ${delay / 1000} seconds...`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw new Error('SonarQube did not become available in time');
};

const processServiceAccount = async (
  sonarUrl: string,
  adminAuth: { username: string; password: string },
  secretArn: string
): Promise<void> => {
  // Retrieve service account credentials
  const serviceAccountSecret = await sm.getSecretValue({ SecretId: secretArn }).promise();
  const serviceAccountCredentials = JSON.parse(serviceAccountSecret.SecretString || '{}');

  // Create user
  await createUser(sonarUrl, adminAuth, serviceAccountCredentials);

  // Assign permissions to the service account user
  await grantPermissions(sonarUrl, adminAuth, serviceAccountCredentials.username);

  // Authenticate as the service account user
  const userAuth = {
    username: serviceAccountCredentials.username,
    password: serviceAccountCredentials.password,
  };

  // Generate token for service account
  const token = await generateUserToken(sonarUrl, userAuth);

  // Update service account secret with token
  serviceAccountCredentials.token = token;
  await sm
    .putSecretValue({
      SecretId: secretArn,
      SecretString: JSON.stringify(serviceAccountCredentials),
    })
    .promise();
};

const createUser = async (
  sonarUrl: string,
  adminAuth: { username: string; password: string },
  userCredentials: { username: string; password: string }
): Promise<void> => {
  console.log(`Creating user ${userCredentials.username}...`);
  try {
    const postData = qs.stringify({
      login: userCredentials.username,
      name: userCredentials.username,
      password: userCredentials.password,
    });

    await axios.post(`${sonarUrl}/api/users/create`, postData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      auth: adminAuth,
    });
    console.log(`User ${userCredentials.username} created`);
  } catch (error: any) {
    if (
      error.response &&
      error.response.status === 400 &&
      error.response.data.errors[0].msg.includes('already exists')
    ) {
      console.log(`User ${userCredentials.username} already exists`);
    } else {
      console.error(`Error creating user: ${error.message}`);
      throw error;
    }
  }
};

const grantPermissions = async (
  sonarUrl: string,
  adminAuth: { username: string; password: string },
  username: string
): Promise<void> => {
  console.log(`Granting permissions to user ${username}...`);
  try {
    const postData = qs.stringify({
      login: username,
      permission: 'scan',
    });

    await axios.post(`${sonarUrl}/api/permissions/add_user`, postData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      auth: adminAuth,
    });
    console.log(`Permission 'scan' granted to user ${username}`);
  } catch (error: any) {
    console.error(`Error granting permissions: ${error.message}`);
    throw error;
  }
};

const generateUserToken = async (
  sonarUrl: string,
  userAuth: { username: string; password: string }
): Promise<string> => {
  console.log(`Generating token for user ${userAuth.username}...`);
  const postData = qs.stringify({
    name: `${userAuth.username}-token`,
  });

  const response = await axios.post(`${sonarUrl}/api/user_tokens/generate`, postData, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    auth: userAuth,
  });

  const token = response.data.token;
  console.log(`Token generated for user ${userAuth.username}`);
  return token;
};

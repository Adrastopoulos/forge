import * as AWS from 'aws-sdk';
import axios from 'axios';

const sm = new AWS.SecretsManager();

export const handler = async (): Promise<void> => {
  const sonarUrl = process.env.SONAR_URL;
  const adminSecretArn = process.env.SONAR_ADMIN_SECRET_ARN;
  const serviceAccountSecretArn = process.env.SONAR_SERVICE_ACCOUNT_SECRET_ARN;

  if (!sonarUrl || !adminSecretArn || !serviceAccountSecretArn) {
    throw new Error(
      'Environment variables SONAR_URL, SONAR_ADMIN_SECRET_ARN, and SONAR_SERVICE_ACCOUNT_SECRET_ARN must be set'
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

  // Create service account
  const serviceAccountSecret = await sm.getSecretValue({ SecretId: serviceAccountSecretArn }).promise();
  const serviceAccountCredentials = JSON.parse(serviceAccountSecret.SecretString || '{}');

  // Create user
  await createUser(sonarUrl, adminAuth, serviceAccountCredentials);

  // Generate token for service account
  const token = await generateUserToken(sonarUrl, adminAuth, serviceAccountCredentials.username);

  // Update service account secret with token
  serviceAccountCredentials.token = token;
  await sm
    .updateSecret({
      SecretId: serviceAccountSecretArn,
      SecretString: JSON.stringify(serviceAccountCredentials),
    })
    .promise();
};

const waitForSonarQube = async (sonarUrl: string): Promise<void> => {
  console.log('Waiting for SonarQube to be available...');
  const maxAttempts = 30;
  const delay = 10000; // 10 seconds

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await axios.get(`${sonarUrl}/api/system/status`);
      console.log('SonarQube is available');
      return;
    } catch (error) {
      console.log(`SonarQube not available yet. Retrying in ${delay / 1000} seconds...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error('SonarQube did not become available in time');
};

const createUser = async (
  sonarUrl: string,
  adminAuth: { username: string; password: string },
  userCredentials: { username: string; password: string }
): Promise<void> => {
  console.log(`Creating user ${userCredentials.username}...`);
  try {
    await axios.post(`${sonarUrl}/api/users/create`, null, {
      params: {
        login: userCredentials.username,
        name: userCredentials.username,
        password: userCredentials.password,
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
      throw error;
    }
  }
};

const generateUserToken = async (
  sonarUrl: string,
  adminAuth: { username: string; password: string },
  username: string
): Promise<string> => {
  console.log(`Generating token for user ${username}...`);
  const response = await axios.post(`${sonarUrl}/api/user_tokens/generate`, null, {
    params: {
      name: `${username}-token`,
      login: username,
    },
    auth: adminAuth,
  });

  const token = response.data.token;
  console.log(`Token generated for user ${username}`);
  return token;
};

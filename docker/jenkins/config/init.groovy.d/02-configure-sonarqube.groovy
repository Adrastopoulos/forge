import jenkins.model.*
import hudson.plugins.sonar.*
import hudson.plugins.sonar.model.*

def env = System.getenv()
def jenkins = Jenkins.getInstance()

def sonarConfig = jenkins.getDescriptor(SonarGlobalConfiguration.class)
def sonarInst = new SonarInstallation(
    "SonarQube",
    env.SONAR_HOST_URL,
    env.SONAR_TOKEN,
    "", "", "", "", "", ""
)

sonarConfig.setInstallations(sonarInst)
sonarConfig.save()
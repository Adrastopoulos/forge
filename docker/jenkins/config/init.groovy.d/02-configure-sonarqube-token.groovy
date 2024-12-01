import jenkins.model.*
import hudson.plugins.sonar.*

def env = System.getenv()
def jenkins = Jenkins.getInstance()

def sonarConfig = jenkins.getDescriptorByType(SonarGlobalConfiguration)

def sonarInst = new SonarInstallation(
    "SonarQube",             // Name
    env.SONAR_HOST_URL,      // Server URL
    env.SONAR_TOKEN,         // Server authentication token
    '2.17.3',             // SonarQube Scanner version
    '',                    // No additional properties
    new hudson.plugins.sonar.model.TriggersConfig(),     // Triggers
    ''                    // No build breaker
)

sonarConfig.setInstallations(sonarInst)
sonarConfig.save()

println "SonarQube configuration saved"

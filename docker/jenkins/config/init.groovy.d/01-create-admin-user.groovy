import jenkins.model.*
import hudson.security.*

def env = System.getenv()

def jenkins = Jenkins.getInstance()
def hudsonRealm = new HudsonPrivateSecurityRealm(false)
def adminUsername = env.JENKINS_ADMIN_USERNAME ?: 'admin'
def adminPassword = env.JENKINS_ADMIN_PASSWORD ?: 'admin'

hudsonRealm.createAccount(adminUsername, adminPassword)
jenkins.setSecurityRealm(hudsonRealm)
jenkins.save()
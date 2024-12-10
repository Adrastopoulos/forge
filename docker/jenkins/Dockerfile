FROM jenkins/jenkins:lts-jdk17

USER root
RUN apt-get update && apt-get install -y lsb-release ansible sshpass openssh-client && rm -rf /var/lib/apt/lists/*

# Copy Jenkins configuration
COPY --chown=jenkins:jenkins "config/jenkins.yaml" "/usr/share/jenkins/ref/jenkins.yaml"
COPY --chown=jenkins:jenkins "config/plugins.txt" "/usr/share/jenkins/ref/plugins.txt"
COPY --chown=jenkins:jenkins "config/init.groovy.d/" "/usr/share/jenkins/ref/init.groovy.d/"

# Copy Ansible configuration
COPY --chown=jenkins:jenkins "ansible/deploy-petclinic.yml" "/usr/share/ansible/deploy-petclinic.yml"
COPY --chown=jenkins:jenkins "ansible/ansible.cfg" "/etc/ansible/ansible.cfg"

USER jenkins
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt
#!/bin/sh
set -e

if [ -n "$USERNAME" ] && [ -n "$PASSWORD" ]; then
  echo "Setting up basic authentication for user: $USERNAME"
  apk add --no-cache apache2-utils
  htpasswd -bc /etc/nginx/.htpasswd "$USERNAME" "$PASSWORD"
else
  echo "No USERNAME and PASSWORD provided, disabling authentication"
  sed -i 's/auth_basic "Restricted Access";/auth_basic off;/' /etc/nginx/conf.d/default.conf
  sed -i 's/auth_basic_user_file \/etc\/nginx\/.htpasswd;//' /etc/nginx/conf.d/default.conf
fi

if [ -S /var/run/docker.sock ]; then
  DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
  if [ "$DOCKER_GID" != "0" ]; then
    echo "Creating docker group with GID: $DOCKER_GID"
    addgroup -g $DOCKER_GID docker
    addgroup nginx docker

    chmod 660 /var/run/docker.sock
    chown root:docker /var/run/docker.sock
  else
    chmod 660 /var/run/docker.sock
  fi
  echo "Docker socket configured"
else
  echo "Docker socket not found at /var/run/docker.sock"
fi

exec "$@"

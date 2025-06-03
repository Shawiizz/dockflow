#!/bin/bash
# Nginx configuration validation script with automatic rollback

set -e

BACKUP_DIR="/tmp/nginx_config_backup_$(date +%s)"
CONFIG_DIR="/etc/nginx"

echo "=== Creating Nginx configuration backup ==="
mkdir -p "$BACKUP_DIR"
cp -r "$CONFIG_DIR/conf.d" "$CONFIG_DIR/sites-available" "$CONFIG_DIR/sites-enabled" "$BACKUP_DIR/" 2>/dev/null || true

echo "=== Testing Nginx configuration syntax ==="
if ! nginx -t; then
  echo "ERROR: Invalid Nginx configuration"
  
  echo "=== Restoring previous configuration ==="
  rm -rf "$CONFIG_DIR/conf.d" "$CONFIG_DIR/sites-available" "$CONFIG_DIR/sites-enabled" 2>/dev/null || true
  cp -r "$BACKUP_DIR/conf.d" "$BACKUP_DIR/sites-available" "$BACKUP_DIR/sites-enabled" "$CONFIG_DIR/" 2>/dev/null || true
  
  echo "=== Restarting Nginx with restored configuration ==="
  systemctl restart nginx || true
  
  echo "=== Cleaning up temporary files ==="
  rm -rf "$BACKUP_DIR"
  
  exit 1
fi

echo "=== Nginx configuration validated successfully ==="
rm -rf "$BACKUP_DIR"

exit 0

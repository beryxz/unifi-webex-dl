#!/bin/bash

set -e

if ! docker image inspect unifi-webex-dl:latest &>/dev/null; then
    docker build -t unifi-webex-dl .
fi

if [ ! -f "./config.json" ]; then
    echo "Missing './config.json' file";
    exit 1
fi

if [ ! -d "./downloads" ]; then
    echo "Missing './downloads' folder, creating it";
    mkdir ./downloads
fi

docker run --rm --init -it \
    -v "$PWD/config.json":/app/config/config.json \
    -v "$PWD/downloads":/app/downloads \
    unifi-webex-dl

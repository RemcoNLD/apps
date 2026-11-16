#!/bin/sh
# Keeps the apps page's version badge right: copies APP_VERSION into the <meta name="app-version"> of
# evailability.html. Run before each commit that changes the app (Claude does).
v=$(grep -o 'const APP_VERSION = "[^"]*"' evailability.html | cut -d'"' -f2)
sed -i "s|<meta name=\"app-version\" content=\"[^\"]*\">|<meta name=\"app-version\" content=\"$v\">|" evailability.html
echo "app-version: $v"

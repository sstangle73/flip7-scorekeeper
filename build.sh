#!/bin/sh
# src/page.html (title, styles, markup) + src/app.js  ->  app.html  ->  index.html
set -e

# app.html: the Artifact-ready fragment
{
  cat src/page.html
  printf '%s\n' '<script>'
  cat src/app.js
  printf '%s\n' '</script>'
} > app.html

# index.html: the same thing as a standalone page
{
  printf '%s\n' '<!doctype html>'
  printf '%s\n' '<html lang="en">'
  printf '%s\n' '<head>'
  printf '%s\n' '<meta charset="utf-8">'
  printf '%s\n' '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
  printf '%s\n' '<meta name="color-scheme" content="light dark">'
  printf '%s\n' '<meta name="description" content="Tap the cards in front of each player and score a round of Flip 7.">'
  cat app.html
  printf '%s\n' '</body>'
  printf '%s\n' '</html>'
} > index.html

echo "built app.html ($(wc -l < app.html) lines) and index.html"

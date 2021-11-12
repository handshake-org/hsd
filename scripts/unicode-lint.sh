#!/usr/bin/env bash

filter_ignore() {
  filtered="$1"

  # Filter Mnemonic keywords
  filtered=`echo "$filtered" | grep -v '^\./lib/hd/words/\(french\|italian\|japanese\|spanish\|chinese-traditional\|chinese-simplified\)\.js$'`

  # filter cached files
  filtered=`echo "$filtered" | grep -v '^./node_modules/.cache'`

  # filter ci dependencies
  filtered=`echo "$filtered" | grep -v '^./node_modules/\(bslint\|@hns-dev/bsdoc\)'`
  filtered=`echo "$filtered" | grep -v '^./node_modules/\(qs\|is-windows\|psl\|js-yaml\|argparse\)'`
  filtered=`echo "$filtered" | grep -v '^./node_modules/\(form-data\|chalk\|jsesc\|json5\|browserslist\)'`
  filtered=`echo "$filtered" | grep -v '^./node_modules/\(istanbul-lib-source-maps\|archy\|esprima\)'`
  filtered=`echo "$filtered" | grep -v '^./node_modules/\(foreground-child\|asynckit\|aws4\)'`


  echo "$filtered"
}

get_whitelist() {
  # Copryright of Jan Schär in faye-websocket.js from node_modules
  echo "ä"
}

# Start
# Check everything for blacklists.
blacklist_matches=`grep $'[\u202A-\u202E\u2066-\u2069]' -r . --include='*.js' -l`
status=$?

if [[ $status -eq 0 ]]; then
  echo "Found blacklisted symbols"
  echo "More info at https://github.com/handshake-org/hsd/pull/658"
  echo "Files:"
  for file in $blacklist_matches; do
    echo "  $file"
  done
  exit 1
fi

# Check files only have whitelisted characters
white_list=`get_whitelist`
check_symbols=$'[^\u0020-\u007e\r\t'$white_list']'
whitelist_matches=`grep "$check_symbols" -r . --include='*.js' -l`
filtered=`filter_ignore "$whitelist_matches"`

if [[ `echo "$filtered" | wc -l` -gt 1 ]]; then
  echo "Found non-whitelisted symbols"
  echo "More info at https://github.com/handshake-org/hsd/pull/658"
  echo "Files:"
  for file in $filtered; do
    echo "  $file"
  done
  exit 1
fi

exit 0

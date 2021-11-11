#!/usr/bin/env bash

filter_ignore() {
  # Filter Mnemonic keywords
  filtered=`echo "$1" | grep -v '^\./lib/hd/words/\(french\|italian\|japanese\|spanish\|chinese-traditional\|chinese-simplified\)\.js$'`

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

check_blacklist() {
  # Source https://blog.rust-lang.org/2021/11/01/cve-2021-42574.html
  grep $'[\u202A-\u202E\u2066-\u2069]' "$1"
  exit $?
}

check_whitelist() {
  white_list=`get_whitelist`
  check_symbols=$'[^\u0020-\u007e\r\t'$white_list']'

  grep $check_symbols "$1"
  exit $?
}

# Start
all_files=`find . -iname '*.js' -print`

# Run blacklist against every file
IFS=$'\n'
for file in `echo "$all_files"`; do
  res=`check_blacklist $file`
  status=$?

  if [[ $status -eq 1 ]]; then
    continue
  fi

  echo -e "Found blacklisted symbols in $file !!!\n"
  echo "More info at https://github.com/handshake-org/hsd/pull/658"
  exit 1
done
unset IFS

# add this script and bin folder
add_files=`echo -e "$0\n$all_files\n$(find ./bin -type f)"`
filtered=`filter_ignore "$add_files"`

IFS=$'\n'
for file in `echo "$filtered"`; do
  res=`check_whitelist $file`
  status=$?

  if [[ $status -eq 1 ]]; then
    continue
  fi

  echo -e "Found bad symbols in $file.\nPlease either fix or add to the ignore list."
  echo "More info at https://github.com/handshake-org/hsd/pull/658"
  exit 1
done
unset IFS

exit 0

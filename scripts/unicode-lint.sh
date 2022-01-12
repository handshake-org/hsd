#!/usr/bin/env bash

filter_ignore() {
  filtered="$1"

  # Filter Mnemonic keywords
  filtered=`echo "$filtered" | grep -v '^lib/hd/words/\(french\|italian\|japanese\|spanish\|chinese-traditional\|chinese-simplified\)\.js$'`
  filtered=`echo "$filtered" | grep -v '^test/data/mnemonic-japanese.json'`

  # Generated docs
  filtered=`echo "$filtered" | grep -v '^./docs/reference'`

  echo "$filtered"
}

# Get file extentions:
#   find . -iname '*.*' -exec sh -c "echo {} | sed  's|.*\.||g'" \; | sort -u
includes="--include='*.c' \
  --include='*.cc' \
  --include='*.cmake' \
  --include='*.gyp' \
  --include='*.gypi' \
  --include='*.h' \
  --include='*.js'
  "

# Start
# Check everything for disallowed list.
check_symbols=$'[\u202A-\u202E\u2066-\u2069]'
disallowed_matches=`sh -c "grep \"$check_symbols\" -r . -l $includes"`
status=$?

if [[ $status -eq 0 ]]; then
  echo "Found disallowed symbols"
  echo "More info at https://github.com/handshake-org/hsd/pull/658"
  echo "Files:"
  for file in $disallowed_matches; do
    echo "  $file"
  done
  exit 1
fi

# Check files only have allowed characters
check_symbols=$'[^\u0020-\u007e\r\t\f]'
allowed_list_matches=`sh -c "grep \"$check_symbols\" -r $(cat .eslintfiles | xargs) -l $includes"`

# See the logs
# sh -c "grep \"$check_symbols\" -r $(cat .eslintfiles | xargs) $includes"


filtered=`filter_ignore "$allowed_list_matches"`

if [[ `echo "$filtered" | wc -l` -gt 1 ]]; then
  echo "Found not allowed symbols"
  echo "More info at https://github.com/handshake-org/hsd/pull/658"
  echo "Files:"
  for file in $filtered; do
    echo "  $file"
  done
  exit 1
fi

exit 0

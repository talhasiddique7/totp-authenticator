.PHONY: check test schema package

JS_FILES := extension.js prefs.js $(wildcard lib/*.js ui/*.js test/*.js)

check: test schema
	@if command -v node >/dev/null 2>&1; then \
		for file in $(JS_FILES); do node --check "$$file" || exit $$?; done; \
	else \
		printf '%s\n' 'Node.js unavailable; skipped the additional JavaScript syntax check.'; \
	fi

test:
	gjs -m test/totp.test.js
	gjs -m test/otpauth.test.js

schema:
	glib-compile-schemas --strict --dry-run schemas

package:
	./build.sh

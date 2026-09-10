PYTHON ?= python3

.PHONY: all build test package registry

all: registry

build:
	$(PYTHON) scripts/build.py

test:
	$(PYTHON) scripts/build.py --test

package: build
	$(PYTHON) scripts/package_release.py

registry: package
	$(PYTHON) scripts/generate_registry.py

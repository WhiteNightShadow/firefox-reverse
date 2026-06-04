# firefox-reverse top-level Makefile
# 详细说明见 scripts/ 各脚本和 docs/architecture.md

SHELL := /bin/bash
UPSTREAM_DIR ?= upstream
BUILD_DIR ?= build

.PHONY: help bootstrap patch build package clean reset

help:
	@echo "firefox-reverse build targets:"
	@echo "  make bootstrap   - 拉取上游 mozilla-firefox/firefox 源码"
	@echo "  make patch       - 应用 patches/ 下所有补丁"
	@echo "  make build       - 编译"
	@echo "  make package     - 打包为多端产物（依赖 firefox-reverse-build/）"
	@echo "  make clean       - 清理构建产物"
	@echo "  make reset       - 还原 upstream/ 到干净状态（撤销所有补丁）"

bootstrap:
	./scripts/bootstrap.sh

patch:
	./scripts/apply-patches.sh

build:
	./scripts/build.sh

package:
	./scripts/package.sh

clean:
	rm -rf $(BUILD_DIR) $(UPSTREAM_DIR)/obj-*

reset:
	cd $(UPSTREAM_DIR) && git reset --hard && git clean -fdx

#!/usr/bin/env python3
"""Exercise the actual Frx reader with narrow XPCOM/pref stubs and real JsonCpp.

This tests source selection, schema, immutable publication and seed dispatch.
It is not a substitute for Gecko ABI, Windows or real-browser acceptance.
"""
import json
import copy
import os
from pathlib import Path
import subprocess
import tempfile

REPOSITORY = Path(__file__).resolve().parents[1]
SOURCE = REPOSITORY / "additions"
UPSTREAM = Path(os.environ.get("FRX_UPSTREAM_DIR", REPOSITORY / "upstream"))
CONFIG = SOURCE / "dom/base/FrxFingerprintConfig.cpp"
assert "/.firefox-reverse/environments/.current-process/fingerprint.json" not in CONFIG.read_text()

STUBS = {
    "nsString.h": r'''#pragma once
#include <string>
class nsACString { public: std::string data; void Assign(const char* s) { data=s; } void Assign(const char* s,size_t n) {data.assign(s,n);} void Assign(const nsACString& s) {data=s.data;} void Truncate(){data.clear();} bool IsEmpty() const {return data.empty();} const char* get() const {return data.c_str();} size_t Length() const {return data.size();} };
class nsCString: public nsACString { public: nsCString()=default; explicit nsCString(const char* s){Assign(s);} };
class nsAString: public nsACString { public: void Assign(const nsAString& s) {data=s.data;} };
class nsString: public nsAString {};
class NS_ConvertUTF8toUTF16: public nsString { public: NS_ConvertUTF8toUTF16(const char* s,size_t n) {data.assign(s,n);} };
using nsAutoCString=nsCString; using nsAutoString=nsString;
''',
    "nsTArray.h": r'''#pragma once
#include <vector>
template<class T> class nsTArray {std::vector<T> values; public: void Clear(){values.clear();} void AppendElement(const T& value){values.push_back(value);} };
''',
    "mozilla/Maybe.h": r'''#pragma once
#include <optional>
namespace mozilla { struct NothingTag{}; inline NothingTag Nothing(){return {};} template<class T> class Maybe {std::optional<T> value_; public: Maybe()=default; Maybe(NothingTag){} Maybe(T v):value_(v){} bool isSome()const{return value_.has_value();} bool isNothing()const{return !isSome();} const T& value()const{return value_.value();} }; template<class T> Maybe<T> Some(T value){return Maybe<T>(value);} }
''',
    "mozilla/Preferences.h": r'''#pragma once
#include <map>
#include <string>
#include "nsError.h"
#include "nsString.h"
namespace frx_test {
inline std::map<std::string,std::string> defaultPrefs, userPrefs;
inline bool contentProcess=false;
inline unsigned prefReads=0, prefWrites=0, clearUsers=0, fileReads=0;
}
namespace mozilla {
enum class PrefValueKind : uint8_t { Default, User };
class Preferences { public:
static nsresult SetCString(const char* name,const char* value,PrefValueKind kind=PrefValueKind::User) {
  ++frx_test::prefWrites;
  if(frx_test::contentProcess)return NS_ERROR_FAILURE;
  auto& prefs=kind==PrefValueKind::Default?frx_test::defaultPrefs:frx_test::userPrefs;
  prefs[name]=value; return NS_OK;
}
static nsresult SetCString(const char* name,const nsACString& value,PrefValueKind kind=PrefValueKind::User) {
  return SetCString(name,value.get(),kind);
}
static nsresult GetCString(const char* name,nsACString& value,PrefValueKind kind=PrefValueKind::User) {
  ++frx_test::prefReads;
  if(kind==PrefValueKind::User) {auto user=frx_test::userPrefs.find(name); if(user!=frx_test::userPrefs.end()){value.Assign(user->second.c_str());return NS_OK;}}
  auto found=frx_test::defaultPrefs.find(name);
  if(found==frx_test::defaultPrefs.end())return NS_ERROR_FAILURE;
  value.Assign(found->second.c_str());return NS_OK;
}
static nsresult ClearUser(const char* name) {
  ++frx_test::clearUsers;
  if(frx_test::contentProcess)return NS_ERROR_FAILURE;
  frx_test::userPrefs.erase(name); return NS_OK;
}
};
}
''',
    "nsError.h": r'''#pragma once
#include <cstdint>
using nsresult=int;
constexpr nsresult NS_OK=0, NS_ERROR_FAILURE=1;
#define NS_SUCCEEDED(result) ((result)==NS_OK)
#define NS_FAILED(result) ((result)!=NS_OK)
''',
    "nsXULAppAPI.h": r'''#pragma once
#include "mozilla/Preferences.h"
inline bool XRE_IsParentProcess(){return !frx_test::contentProcess;}
inline bool XRE_IsContentProcess(){return frx_test::contentProcess;}
''',
    "nsThreadUtils.h": r'''#pragma once
#include <thread>
namespace frx_test {inline const auto mainThread=std::this_thread::get_id();}
inline bool NS_IsMainThread(){return std::this_thread::get_id()==frx_test::mainThread;}
''',
    "mozilla/RandomNum.h": r'''#pragma once
#include <cstddef>
#include <cstdlib>
namespace mozilla {inline bool GenerateRandomBytesFromOS(void* buffer,size_t length){
  if(getenv("FRX_TEST_RANDOM_FAILURE"))return false;
  static unsigned counter=0;
  const char* start=getenv("FRX_TEST_RANDOM_OFFSET");
  const unsigned offset=start?unsigned(std::strtoul(start,nullptr,10)):0;
  for(size_t i=0;i<length;i++)static_cast<unsigned char*>(buffer)[i]=static_cast<unsigned char>(offset+counter++);
  return true;
}}
''',
    # Instrument only the actual reader translation unit (compiled separately
    # below), so child tests prove that no config file was even opened.
    "frx_file_reads.h": r'''#pragma once
#include <cstdio>
#include "mozilla/Preferences.h"
inline FILE* FrxTestFopen(const char* path,const char* mode){++frx_test::fileReads;return std::fopen(path,mode);}
#define fopen FrxTestFopen
#ifdef XP_WIN
inline FILE* FrxTestWfopen(const wchar_t* path,const wchar_t* mode){++frx_test::fileReads;return ::_wfopen(path,mode);}
#define _wfopen FrxTestWfopen
#endif
''',
    "mozilla/StaticPrefs_frx.h": r'''#pragma once
#include <cstdlib>
#include <memory>
#include "nsString.h"
namespace mozilla::StaticPrefs {inline auto pref(const char* name){auto value=std::make_unique<nsCString>(); if(const char* text=getenv(name))value->Assign(text); return value;} inline auto frx_fingerprint_config_json(){return pref("FRX_TEST_PREF_JSON");} inline auto frx_fingerprint_config_path(){return pref("FRX_TEST_PREF_PATH");} }
''',
    # Mozilla's UTF-8 implementation is covered by Gecko. These fixture strings
    # are valid UTF-8; this stub isolates the surrounding reader control flow.
    "mozilla/Utf8.h": r'''#pragma once
#include <cstddef>
namespace mozilla {template<class T> struct Span {Span(const T*,size_t){}}; inline bool IsUtf8(Span<const char>){return true;} }
''',
}

HARNESS = r'''
#include "FrxFingerprintConfig.h"
#include "json/json.h"
#include "mozilla/Preferences.h"
#include <array>
#include <cassert>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <thread>
#include <vector>
using F=mozilla::dom::FrxFingerprintConfig;
Json::Value Observe() {
  uint64_t seed=123,hardware=0;
  Json::Value result;
  result["active"]=F::GetSurfaceSeed("audio",&seed);
  result["seed"]=Json::UInt64(seed);
  result["status"]=int(F::GetStatus());
  result["enabled"]=F::Enabled();
  result["hardwareActive"]=F::GetHardwareConcurrency(&hardware);
  result["hardware"]=Json::UInt64(hardware);
  nsCString locale,httpUA; nsString language;
  result["localeActive"]=F::GetIntlLocale(locale);
  result["httpUAActive"]=F::GetHttpUserAgent(httpUA);
  result["languageActive"]=F::GetNavigatorLanguage(language);
  nsCString reason,source;F::GetStatusReason(reason);F::GetConfigSource(source);
  result["reason"]=reason.data;result["source"]=source.data;
  result["fileReads"]=frx_test::fileReads;
  result["prefReads"]=frx_test::prefReads;
  result["prefWrites"]=frx_test::prefWrites;
  return result;
}
Json::Value ExportPrefs() {
  Json::Value output(Json::objectValue);
  output["defaultPrefs"]=Json::Value(Json::objectValue);
  output["userPrefs"]=Json::Value(Json::objectValue);
  for(const auto& item:frx_test::defaultPrefs)output["defaultPrefs"][item.first]=item.second;
  for(const auto& item:frx_test::userPrefs)output["userPrefs"][item.first]=item.second;
  return output;
}
void WriteJson(const Json::Value& output) {
  Json::StreamWriterBuilder writer;writer["indentation"]="";
  std::cout<<Json::writeString(writer,output);
}
int main(int argc,char** argv) {
  const std::string mode=argc>1?argv[1]:"normal";
  if(mode=="child"||mode=="parent-publish"||mode=="parent-publish-mutate") {
    Json::Value input;std::cin>>input;
    for(const auto& key:input["defaultPrefs"].getMemberNames())frx_test::defaultPrefs[key]=input["defaultPrefs"][key].asString();
    for(const auto& key:input["userPrefs"].getMemberNames())frx_test::userPrefs[key]=input["userPrefs"][key].asString();
    frx_test::contentProcess=mode=="child";
    Json::Value output;
    if(mode=="child") {
      nsCString forbiddenToken;
      assert(!F::PrepareContentSnapshot(forbiddenToken));
      assert(forbiddenToken.IsEmpty()&&frx_test::prefWrites==0);
      output["observed"]=Observe();
      const unsigned reads=frx_test::prefReads, fileReads=frx_test::fileReads;
      // A cached child getter must not re-read even damaged preference state.
      frx_test::defaultPrefs.clear();frx_test::userPrefs.clear();
      assert(Observe()==output["observed"]);
      assert(reads==frx_test::prefReads&&fileReads==frx_test::fileReads);
      std::thread worker([&]{assert(Observe()==output["observed"]);});worker.join();
    } else {
      nsCString token;
      output["prepared"]=F::PrepareContentSnapshot(token);
      output["token"]=token.data;
      output["observed"]=Observe();
      output["snapshot"]=ExportPrefs();
      if(mode=="parent-publish-mutate") {
        std::ofstream out(getenv("MOZ_FRX_FINGERPRINT_CONFIG"));out<<argv[2];out.close();
        nsCString again;
        output["preparedAgain"]=F::PrepareContentSnapshot(again);
        output["tokenAgain"]=again.data;
        output["snapshotAgain"]=ExportPrefs();
        output["observedAgain"]=Observe();
      }
    }
    WriteJson(output);return 0;
  }
  uint64_t seed=123; const bool active=F::GetSurfaceSeed("audio",&seed);
  if(mode=="cache-file") {std::ofstream out(getenv("MOZ_FRX_FINGERPRINT_CONFIG"));out<<argv[2];out.close();}
  if(mode=="cache-inline") {
#ifdef XP_WIN
    _putenv_s("MOZ_FRX_FINGERPRINT_JSON",argv[2]);
#else
    setenv("MOZ_FRX_FINGERPRINT_JSON",argv[2],1);
#endif
  }
  if(mode=="threads") {std::array<uint64_t,16> values{};std::vector<std::thread> threads;
    for(size_t i=0;i<values.size();i++)threads.emplace_back([&,i]{assert(F::GetSurfaceSeed("audio",&values[i]));});
    for(auto& thread:threads)thread.join();for(auto value:values)assert(value==seed);
  }
  uint64_t second=123; const bool active2=F::GetSurfaceSeed("audio",&second);
  assert(active==active2&&seed==second);assert(!F::GetSurfaceSeed("canvas",&second));
  WriteJson(Observe());
}
'''

with tempfile.TemporaryDirectory(prefix="frx-frx-reader-") as temporary:
    base = Path(temporary)
    for name, value in STUBS.items():
        target = base / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)
    harness = base / "reader.cpp"
    harness.write_text(HARNESS)
    binary = base / "reader-test"
    cpp = UPSTREAM / "toolkit/components/jsoncpp"
    command = [os.environ.get("CXX", "c++"), "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pthread", "-I", str(base), "-I", str(SOURCE / "dom/base"), "-I", str(cpp / "include")]
    if os.name == "nt":
        command.insert(1, "-DXP_WIN")
    config_object = base / "reader.o"
    subprocess.run([*command, "-include", str(base / "frx_file_reads.h"), "-c", str(CONFIG), "-o", str(config_object)], check=True)
    subprocess.run([*command, str(harness), str(config_object), *[str(cpp / "src/lib_json" / filename) for filename in ["json_reader.cpp", "json_value.cpp", "json_writer.cpp"]], "-o", str(binary)], check=True)
    clean = {key: value for key, value in os.environ.items() if not key.startswith(("MOZ_FRX_", "FRX_ENV_", "FRX_TEST_"))}
    count = 0

    def fixture():
        return {"schemaVersion": 1, "consistency": {"mode": "native-consistent", "version": 1}, "enabled": True, "seed_mode": "persistent", "audio": {"enabled": True, "mode": "seeded", "scope": "profile", "seed": {"enabled": True, "value": "0" * 64}}}

    def run(config=None, status=1, active=True, source=None, environment=None, arguments=()):
        global count
        env = dict(clean)
        if config is not None:
            env["MOZ_FRX_FINGERPRINT_JSON"] = config if isinstance(config, str) else json.dumps(config)
        env.update(environment or {})
        observed = json.loads(subprocess.check_output([str(binary), *arguments], env=env, text=True))
        assert observed["status"] == status, observed
        assert observed["active"] is active, observed
        if source is not None:
            assert observed["source"] == source, observed
        count += 1
        return observed

    def phase(mode, config=None, environment=None, prefs=None, arguments=()):
        env = dict(clean)
        if config is not None:
            env["MOZ_FRX_FINGERPRINT_JSON"] = config if isinstance(config, str) else json.dumps(config)
        env.update(environment or {})
        result = json.loads(subprocess.check_output(
            [str(binary), mode, *arguments], env=env, text=True,
            input=json.dumps(prefs or {"defaultPrefs": {}, "userPrefs": {}}), timeout=15))
        if mode.startswith("parent-"):
            result["inheritedEnvironment"] = {key: value for key, value in (environment or {}).items() if key == "MOZ_FRX_FINGERPRINT_CONFIG"}
        return result

    def identity(observed):
        return {key: observed[key] for key in ("status", "active", "seed", "enabled", "hardwareActive", "hardware", "reason", "source")}

    def forwarded(publication, environment=None, config=None, prefs=None, status=None):
        """A new process consumes only a serialized parent/default-pref snapshot."""
        global count
        env = {**publication.get("inheritedEnvironment", {}), "MOZ_FRX_PARENT_CONFIG_TOKEN": publication["token"]}
        env.update(environment or {})
        result = phase("child", config=config, environment=env, prefs=prefs or publication["snapshot"])["observed"]
        assert result["fileReads"] == 0, "child opened a configuration file"
        assert result["prefWrites"] == 0, "child changed bootstrap preferences"
        if status is None and config is None:
            expected = identity(publication["observed"])
            expected["source"] = "parent-snapshot"
            assert identity(result) == expected, "parent/child config mismatch"
        elif status is not None:
            assert result["status"] == status, "unexpected child status"
        count += 1
        return result

    assert run(fixture())["seed"] == 0
    run(None, 0, False, "none")
    run(None, 0, False, "none", arguments=("cache-inline", json.dumps(fixture())))
    run("invalid-json", 2, False, "environment-json", arguments=("cache-inline", json.dumps(fixture())))
    run({"enabled": False}, 1, False, "environment-json", arguments=("cache-inline", json.dumps(fixture())))
    old_metadata = fixture()
    del old_metadata["consistency"]
    old_metadata["audio"]["seed"]["value"] = "legacy-opaque-seed"
    run(old_metadata, 1, False)
    groups = fixture()
    groups.update(navigator={"language": "en-US", "languages": ["en-US"], "userAgent": "Firefox/153.0"}, intl={"enabled": False, "locale": "fr-FR"}, http={"enabled": False, "userAgent": "Firefox/153.0"})
    disabled_groups = run(groups)
    assert not disabled_groups["localeActive"] and not disabled_groups["httpUAActive"]
    groups["navigator"]["enabled"] = False
    assert not run(groups)["languageActive"]
    run(None, 2, False, "none", {"MOZ_FRX_ENV_ID": "owned-test-environment"})
    for mutation in [
        lambda c: c.update(enabled=False),
        lambda c: c["audio"].update(enabled=False),
        lambda c: c["audio"].update(mode={"enabled": False, "value": "seeded"}),
        lambda c: c["audio"]["seed"].update(enabled=False),
    ]:
        config = fixture(); mutation(config); run(config, 1, False)
    for mutation in [
        lambda c: c["audio"].update(enabled="true"),
        lambda c: c["audio"].update(mode={"enabled": "true", "value": "seeded"}),
        lambda c: c["audio"].update(scope="origin"),
        lambda c: c.update(seed_mode="session"),
        lambda c: c["audio"]["seed"].update(value="a" * 63 + "g"),
        lambda c: c["audio"]["seed"].update(value="a" * 32),
        lambda c: c["audio"].update(sampleRate=48000),
        lambda c: c["audio"].update(noise=0),
        lambda c: c["audio"].update(baseLatency=0),
        lambda c: c["consistency"].update(version=2),
        lambda c: c.update(navigator={"userAgent": "Chrome/150.0"}),
        lambda c: c.update(canvas=c["audio"].copy()),
    ]:
        config = fixture(); mutation(config); run(config, 2, False)
    config = fixture()
    config["audio"].update(sampleRate={"enabled": False, "value": None}, noise={"enabled": False, "value": 0}, scope={"enabled": False, "value": "ignored"})
    run(config)
    run('{"enabled":true,"enabled":false}', 2, False)
    run(json.dumps(fixture()) + " trailing", 2, False)
    file = base / "环境-配置.json"
    file.write_text(json.dumps(fixture()))
    run("invalid-json", 2, False, "environment-json", {"MOZ_FRX_FINGERPRINT_CONFIG": str(file), "FRX_TEST_PREF_JSON": json.dumps(fixture())})
    run("", 2, False, "environment-json", {"MOZ_FRX_FINGERPRINT_CONFIG": str(file)})
    run(fixture(), source="environment-json", environment={"MOZ_FRX_FINGERPRINT_CONFIG": str(base / "missing.json")})
    run(None, source="environment-file-once", environment={"MOZ_FRX_FINGERPRINT_CONFIG": str(file)})
    run(None, 2, False, "environment-file-once", {"MOZ_FRX_FINGERPRINT_CONFIG": "relative.json"})
    run(None, source="profile-preference-json", environment={"FRX_TEST_PREF_JSON": json.dumps(fixture())})
    changed = fixture(); changed["audio"]["seed"]["value"] = "f" * 64
    assert run(fixture(), arguments=("cache-inline", json.dumps(changed)))["seed"] == 0
    cache_file = base / "cache.json"; cache_file.write_text(json.dumps(fixture()))
    assert run(None, source="environment-file-once", environment={"MOZ_FRX_FINGERPRINT_CONFIG": str(cache_file)}, arguments=("cache-file", json.dumps(changed)))["seed"] == 0
    run(fixture(), arguments=("threads",))
    legacy_count = count

    metadata_key = "frx.fingerprint.bootstrap.metadata"
    part_prefix = "frx.fingerprint.bootstrap.part."
    stale_users = {metadata_key: "stale-user-metadata", part_prefix + "0": "stale-user-data"}
    snapshot_file = base / "父进程-快照-配置.json"
    snapshot_config = fixture()
    snapshot_config["navigator"] = {"hardwareConcurrency": 7}
    # Non-ASCII text forces the real writer to escape the envelope into ASCII;
    # more than 4 KiB also exercises the actual preference chunking boundary.
    snapshot_config["testPadding"] = "指纹快照" * 2200
    snapshot_json = json.dumps(snapshot_config, ensure_ascii=False)
    snapshot_file.write_text(snapshot_json, encoding="utf-8")
    publication = phase("parent-publish-mutate", environment={"MOZ_FRX_FINGERPRINT_CONFIG": str(snapshot_file)},
                        prefs={"defaultPrefs": {}, "userPrefs": stale_users}, arguments=(json.dumps(changed),))
    assert publication["prepared"] and publication["preparedAgain"], "parent did not publish"
    assert len(publication["token"]) == 32 and all(c in "0123456789abcdef" for c in publication["token"]), "snapshot token must be 128-bit lowercase hex"
    assert publication["tokenAgain"] == publication["token"], "token changed inside one parent"
    assert publication["snapshotAgain"] == publication["snapshot"], "parent reloaded a mutated file"
    assert identity(publication["observedAgain"]) == identity(publication["observed"]), "parent identity changed after republish"
    assert publication["observed"]["fileReads"] == publication["observedAgain"]["fileReads"] == 1, "parent must open the config file only once"
    defaults = publication["snapshot"]["defaultPrefs"]
    metadata = json.loads(defaults[metadata_key])
    assert metadata["token"] == publication["token"], "metadata token mismatch"
    assert isinstance(metadata["chunks"], int) and metadata["chunks"] > 1, "large snapshot was not chunked"
    parts = [defaults[part_prefix + str(index)] for index in range(metadata["chunks"])]
    assert all(0 < len(part.encode("ascii")) <= 4000 for part in parts), "snapshot preference chunk exceeds ASCII size limit"
    envelope = json.loads("".join(parts))
    assert envelope["token"] == publication["token"], "envelope token mismatch"
    assert bytes.fromhex(envelope["jsonHex"]).decode("utf-8") == snapshot_json, "snapshot changed UTF-8 configuration bytes"
    assert bytes.fromhex(envelope["pathHex"]).decode("utf-8") == str(snapshot_file), "snapshot changed UTF-8 file path"
    assert not any(key in publication["snapshot"]["userPrefs"] for key in stale_users), "parent did not clear shadowing user preferences"
    count += 1

    # The parent has already changed the file to seed B, yet each newly started
    # child must consume the original A snapshot. Deletion proves it also works
    # with no accessible backing file, while fopen counters prove no attempt.
    forwarded(publication, {"MOZ_FRX_FINGERPRINT_CONFIG": str(snapshot_file)})
    snapshot_file.unlink()
    forwarded(publication, {"MOZ_FRX_FINGERPRINT_CONFIG": str(snapshot_file)})

    # A fresh parent receives new random bytes; the process-local published
    # nonce is stable across republish but must not be a hard-coded constant.
    another_parent = phase("parent-publish", config=fixture(), environment={"FRX_TEST_RANDOM_OFFSET": "64"})
    assert another_parent["prepared"] and another_parent["token"] != publication["token"], "new parent reused prior nonce"
    count += 1

    # Status and safe diagnostic fields must survive forwarding, including
    # disabled and invalid configurations, without child fallback or reparsing
    # a changed legacy preference/file as a different identity.
    fallback_file = base / "fallback-must-not-open.json"
    fallback_file.write_text(json.dumps(changed))
    fallback_env = {"FRX_TEST_PREF_PATH": str(fallback_file), "FRX_TEST_PREF_JSON": json.dumps(changed)}
    oversized_file = base / "over-limit.json"
    oversized_file.write_bytes(b" " * (1024 * 1024 + 1))
    for label, config, expected_status, expected_reason, environment in [
        ("loaded", fixture(), 1, "loaded", {}),
        ("disabled", {"enabled": False}, 1, "disabled", {}),
        ("invalid", "invalid-json", 2, "configuration-json-invalid", {}),
        ("empty-inline", "", 2, "explicit-json-invalid", {}),
        ("absent", None, 0, "not-configured", {}),
        ("managed-missing", None, 2, "managed-configuration-missing", {"MOZ_FRX_ENV_ID": "test-owned-environment"}),
        ("file-unreadable", None, 2, "configuration-file-unreadable", {"MOZ_FRX_FINGERPRINT_CONFIG": str(base / "does-not-exist.json")}),
        ("file-over-limit", None, 2, "configuration-file-unreadable", {"MOZ_FRX_FINGERPRINT_CONFIG": str(oversized_file)}),
    ]:
        parent = phase("parent-publish", config=config, environment=environment)
        assert parent["prepared"], label + " publication failed"
        assert parent["observed"]["status"] == expected_status and parent["observed"]["reason"] == expected_reason, label + " parent status mismatch"
        forwarded(parent, fallback_env)

    pref_json_parent = phase("parent-publish", environment={"FRX_TEST_PREF_JSON": json.dumps(fixture())})
    assert pref_json_parent["observed"]["source"] == "profile-preference-json"
    forwarded(pref_json_parent, fallback_env)
    pref_path_parent = phase("parent-publish", environment={"FRX_TEST_PREF_PATH": str(file)})
    assert pref_path_parent["observed"]["source"] == "profile-preference-file-once"
    forwarded(pref_path_parent, fallback_env)

    # A real default snapshot wins even when user.js contains a fully formed
    # but different snapshot. User-only copies cannot impersonate the default
    # branch, even with a matching environment token.
    user_shadowed = copy.deepcopy(publication["snapshot"])
    user_shadowed["userPrefs"] = dict(another_parent["snapshot"]["defaultPrefs"])
    forwarded(publication, fallback_env, prefs=user_shadowed)
    user_only = {"defaultPrefs": {}, "userPrefs": defaults}
    forwarded(publication, fallback_env, prefs=user_only, status=2)
    forwarded(publication, {**fallback_env, "MOZ_FRX_FINGERPRINT_CONFIG": str(fallback_file)})
    missing_path = phase("child", environment={"MOZ_FRX_PARENT_CONFIG_TOKEN": publication["token"]}, prefs=publication["snapshot"])["observed"]
    assert missing_path["status"] == 1 and missing_path["fileReads"] == 0, "child must use the parent snapshot without an inherited path"
    count += 1

    for env, prefs in [
        ({**fallback_env, "MOZ_FRX_PARENT_CONFIG_TOKEN": ""}, publication["snapshot"]),
        ({**fallback_env, "MOZ_FRX_PARENT_CONFIG_TOKEN": "f" * 32}, publication["snapshot"]),
        (fallback_env, {"defaultPrefs": {}, "userPrefs": {}}),
    ]:
        forwarded(publication, env, prefs=prefs, status=2)
    no_nonce = phase("child", environment={**fallback_env, "MOZ_FRX_FINGERPRINT_CONFIG": str(fallback_file)}, prefs=publication["snapshot"])["observed"]
    assert no_nonce["status"] == 2 and no_nonce["fileReads"] == 0, "missing nonce allowed child fallback"
    count += 1

    missing_part = copy.deepcopy(publication["snapshot"])
    del missing_part["defaultPrefs"][part_prefix + "0"]
    forwarded(publication, fallback_env, prefs=missing_part, status=2)
    for broken_metadata in ["not-json", json.dumps({"token": publication["token"], "chunks": 0}), json.dumps({"token": publication["token"], "chunks": 10000000})]:
        damaged = copy.deepcopy(publication["snapshot"])
        damaged["defaultPrefs"][metadata_key] = broken_metadata
        forwarded(publication, fallback_env, prefs=damaged, status=2)
    wrong_envelope = copy.deepcopy(publication["snapshot"])
    envelope["token"] = "f" * 32
    rewritten = json.dumps(envelope, separators=(",", ":"))
    new_parts = [rewritten[index:index + 4000] for index in range(0, len(rewritten), 4000)]
    wrong_envelope["defaultPrefs"][metadata_key] = json.dumps({"token": publication["token"], "chunks": len(new_parts)})
    for index, part in enumerate(new_parts):
        wrong_envelope["defaultPrefs"][part_prefix + str(index)] = part
    forwarded(publication, fallback_env, prefs=wrong_envelope, status=2)

    inline_child = forwarded(publication, fallback_env, config=changed, status=1)
    assert inline_child["seed"] == publication["observed"]["seed"] and inline_child["source"] == "parent-snapshot", "child inline replaced the parent identity"
    for invalid_inline in ["invalid-json", ""]:
        invalid_child = forwarded(publication, fallback_env, config=invalid_inline, status=1)
        assert invalid_child["active"] and invalid_child["source"] == "parent-snapshot", "child inline damaged the parent snapshot"
    inline_no_snapshot = phase("child", config=changed, environment=fallback_env)["observed"]
    assert inline_no_snapshot["status"] == 2 and inline_no_snapshot["fileReads"] == 0, "child inline bypassed the required snapshot"
    count += 1
    print(json.dumps({"passed": count, "legacyPassed": legacy_count, "snapshotPassed": count - legacy_count, "source": "actual FrxFingerprintConfig.cpp", "scope": "reader/seed/default-pref snapshot control flow with narrow platform stubs; not Gecko IPC, sandbox, Windows or real-browser acceptance"}))

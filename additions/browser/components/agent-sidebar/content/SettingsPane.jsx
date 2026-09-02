import React, { useRef, useState } from "react";

function legacyProfile(store, providers) {
  const provider = store.getActiveProvider();
  const p = providers.find(x => x.id === provider) || providers[0];
  return {
    id: "legacy",
    name: `${p?.label || provider} 配置`,
    provider,
    apiKey: store.getApiKey(provider),
    model: store.getModel(provider) || p?.defaultModel || "",
    baseUrl: store.getCustomBaseUrl ? store.getCustomBaseUrl() : "",
    protocol: store.getCustomProtocol ? store.getCustomProtocol() : "openai",
    reasoningEffort: store.getCustomReasoningEffort ? store.getCustomReasoningEffort() : "auto",
  };
}

/** 模型配置管理：同一 provider 可保存多组账号/端点，选择历史配置即可切换。 */
export default function SettingsPane({ store, providers, fetchModels, onClose }) {
  const initialProfiles = store.listModelProfiles
    ? store.listModelProfiles()
    : [legacyProfile(store, providers)];
  const initialId = store.getActiveModelProfileId
    ? store.getActiveModelProfileId()
    : initialProfiles[0].id;
  const initial = initialProfiles.find(p => p.id === initialId) || initialProfiles[0];

  const [profiles, setProfiles] = useState(initialProfiles);
  const [profileId, setProfileId] = useState(initial.id);
  const [profileName, setProfileName] = useState(initial.name);
  const [provider, setProvider] = useState(initial.provider);
  const [apiKey, setApiKey] = useState(initial.apiKey || "");
  const [model, setModel] = useState(initial.model || "");
  const [customUrl, setCustomUrl] = useState(initial.baseUrl || "");
  const [customProtocol, setCustomProtocol] = useState(initial.protocol || "openai");
  const [customReasoningEffort, setCustomReasoningEffort] = useState(initial.reasoningEffort || "auto");
  const [confirmTools, setConfirmTools] = useState(store.getConfirmTools ? store.getConfirmTools() : false);
  const [promptCacheMode, setPromptCacheMode] = useState(store.getPromptCacheMode ? store.getPromptCacheMode() : "auto");
  const [promptCacheTtl, setPromptCacheTtl] = useState(store.getPromptCacheTtl ? store.getPromptCacheTtl() : "default");
  const [contextStrategy, setContextStrategy] = useState(store.getContextStrategy ? store.getContextStrategy() : "projected");
  const [fetchedModels, setFetchedModels] = useState([]);
  const [fetchMsg, setFetchMsg] = useState("");
  const [manual, setManual] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const current = providers.find(p => p.id === provider) || providers[0];
  const isCustom = provider === "custom";
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const fetchSeqRef = useRef(0);

  function refreshProfiles(preferId) {
    if (!store.listModelProfiles) return;
    const next = store.listModelProfiles();
    setProfiles(next);
    if (preferId) setProfileId(preferId);
  }

  function loadProfile(p, message = "") {
    if (!p) return;
    setProfileId(p.id);
    setProfileName(p.name || "模型配置");
    setProvider(p.provider || "deepseek");
    setApiKey(p.apiKey || "");
    setModel(p.model || "");
    setCustomUrl(p.baseUrl || "");
    setCustomProtocol(p.protocol || "openai");
    setCustomReasoningEffort(p.reasoningEffort || "auto");
    setFetchedModels([]);
    setFetchMsg("");
    setManual(false);
    setError("");
    setStatus(message);
  }

  function chooseProfile(id) {
    try {
      const p = store.setActiveModelProfileId
        ? store.setActiveModelProfileId(id)
        : profiles.find(x => x.id === id);
      loadProfile(p, "已切换，下一轮对话使用此配置");
    } catch (e) {
      setError((e && e.message) || String(e));
    }
  }

  function createProfile() {
    if (!store.createModelProfile) return;
    try {
      const p = store.createModelProfile({
        name: `${current?.label || "模型"} 新配置`,
        provider,
        apiKey: "",
        model: model || current?.defaultModel || "",
        baseUrl: isCustom ? customUrl : "",
        protocol: isCustom ? customProtocol : "openai",
        reasoningEffort: isCustom ? customReasoningEffort : "auto",
      });
      refreshProfiles(p.id);
      loadProfile(p, "已新建配置，请填写账号信息后保存");
    } catch (e) {
      setError((e && e.message) || String(e));
    }
  }

  function duplicateProfile() {
    if (!store.duplicateModelProfile) return;
    try {
      const p = store.duplicateModelProfile(profileId);
      refreshProfiles(p.id);
      loadProfile(p, "已复制配置，可修改名称或账号后保存");
    } catch (e) {
      setError((e && e.message) || String(e));
    }
  }

  function deleteProfile() {
    if (!store.deleteModelProfile || profiles.length <= 1) return;
    try {
      if (typeof window !== "undefined" && !window.confirm(`删除模型配置“${profileName}”？`)) return;
      store.deleteModelProfile(profileId);
      const next = store.listModelProfiles();
      const activeId = store.getActiveModelProfileId();
      setProfiles(next);
      loadProfile(next.find(p => p.id === activeId) || next[0], "配置已删除");
    } catch (e) {
      setError((e && e.message) || String(e));
    }
  }

  function onProviderChange(id) {
    const p = providers.find(x => x.id === id);
    setProvider(id);
    setApiKey("");
    setModel(p?.defaultModel || "");
    setFetchedModels([]);
    setFetchMsg("");
    setManual(false);
    setStatus("");
  }

  function save() {
    try {
      let p;
      const values = {
        name: profileName,
        provider,
        apiKey,
        model,
        baseUrl: isCustom ? customUrl : "",
        protocol: isCustom ? customProtocol : "openai",
        reasoningEffort: isCustom ? customReasoningEffort : "auto",
      };
      if (store.updateModelProfile) {
        p = store.updateModelProfile(profileId, values);
        store.setActiveModelProfileId(p.id);
        refreshProfiles(p.id);
      } else {
        store.setActiveProvider(provider);
        store.setApiKey(provider, apiKey);
        store.setModel(provider, model);
        if (isCustom) {
          store.setCustomBaseUrl?.(customUrl);
          store.setCustomProtocol?.(customProtocol);
          store.setCustomReasoningEffort?.(customReasoningEffort);
        }
        p = { ...values, id: profileId };
      }
      store.setConfirmTools?.(confirmTools);
      store.setPromptCacheMode?.(promptCacheMode);
      store.setPromptCacheTtl?.(promptCacheTtl);
      store.setContextStrategy?.(contextStrategy);
      loadProfile(p, "已保存并设为当前配置");
    } catch (e) {
      setError((e && e.message) || String(e));
    }
  }

  async function doFetchModels() {
    if (!fetchModels) return;
    const seq = ++fetchSeqRef.current;
    const forProvider = provider;
    const stale = () => seq !== fetchSeqRef.current || providerRef.current !== forProvider;
    setFetchMsg("获取中…");
    try {
      const list = await fetchModels(isCustom ? customUrl : current.baseUrl, apiKey);
      if (stale()) return;
      setFetchedModels(list);
      setManual(false);
      if (isCustom && customProtocol === "anthropic") {
        const claude = list.filter(x => /claude/i.test(x));
        setFetchMsg(claude.length ? `获取到 ${claude.length} 个 Claude 模型` : "端点未列出 Claude，已使用内置列表");
      } else {
        setFetchMsg(`获取到 ${list.length} 个模型`);
        if (!model && list.length) setModel(list[0]);
      }
    } catch (e) {
      if (!stale()) setFetchMsg("失败：" + ((e && e.message) || e));
    }
  }

  const fetchedClaude = fetchedModels.filter(x => /claude/i.test(x));
  const customModels = customProtocol === "anthropic"
    ? (fetchedClaude.length ? fetchedClaude : current.anthropicModels || [])
    : fetchedModels;
  const modelOptions = isCustom ? customModels : (fetchedModels.length ? fetchedModels : current.models);

  return (
    <div className="settings-pane">
      <header className="settings-pane__bar">
        <span>设置</span>
        {onClose && <button type="button" onClick={onClose} title="关闭">×</button>}
      </header>

      <section className="settings-pane__section">
        <div className="settings-pane__section-title">模型配置</div>
        <div className="settings-pane__profilebar">
          <select value={profileId} onChange={e => chooseProfile(e.target.value)} title="选择已保存的模型账号配置">
            {profiles.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button type="button" onClick={createProfile}>新建</button>
          {store.duplicateModelProfile && <button type="button" onClick={duplicateProfile}>复制</button>}
          <button type="button" onClick={deleteProfile} disabled={profiles.length <= 1}>删除</button>
        </div>
        <span className="settings-pane__hint">选择后立即用于下一轮对话；修改表单后请“保存并使用”。</span>
      </section>

      <label className="settings-pane__field">
        配置名称
        <input type="text" value={profileName} maxLength={60} onChange={e => { setProfileName(e.target.value); setStatus(""); }} />
      </label>

      <label className="settings-pane__field">
        模型提供方
        <select value={provider} onChange={e => onProviderChange(e.target.value)}>
          {providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>

      {isCustom && (
        <>
          <label className="settings-pane__field">
            协议
            <select value={customProtocol} onChange={e => { setCustomProtocol(e.target.value); setFetchedModels([]); setManual(false); setStatus(""); }}>
              <option value="openai">OpenAI 兼容（/v1/chat/completions）</option>
              <option value="anthropic">Anthropic 兼容（/v1/messages）</option>
            </select>
          </label>
          <label className="settings-pane__field">
            Base URL
            <input type="text" value={customUrl} placeholder="https://api.example.com" onChange={e => { setCustomUrl(e.target.value); setStatus(""); }} />
          </label>
        </>
      )}

      <label className="settings-pane__field">
        {isCustom ? "API Key / Token" : "API Key"}
        <input type="password" value={apiKey} placeholder="sk-..." onChange={e => { setApiKey(e.target.value); setStatus(""); }} />
      </label>

      {isCustom && customProtocol === "openai" && (
        <label className="settings-pane__field">
          思考等级
          <select value={customReasoningEffort} onChange={e => { setCustomReasoningEffort(e.target.value); setStatus(""); }}>
            <option value="auto">自动（模型或网关默认）</option>
            <option value="none">关闭（none）</option>
            <option value="minimal">极低（minimal）</option>
            <option value="low">低（low）</option>
            <option value="medium">中（medium）</option>
            <option value="high">高（high）</option>
            <option value="xhigh">极高（xhigh）</option>
            <option value="max">最大（max）</option>
          </select>
        </label>
      )}

      <label className="settings-pane__field">
        模型
        <div className="settings-pane__modelrow">
          {modelOptions.length > 0 && !manual ? (
            <select className="settings-pane__grow" value={model} onChange={e => {
              if (e.target.value === "__manual__") { setManual(true); setModel(""); }
              else setModel(e.target.value);
              setStatus("");
            }}>
              {model && !modelOptions.includes(model) && <option value={model}>{model}（当前）</option>}
              {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
              {isCustom && <option value="__manual__">手动输入其它模型…</option>}
            </select>
          ) : (
            <input className="settings-pane__grow" type="text" value={model} placeholder="模型名" onChange={e => { setModel(e.target.value); setStatus(""); }} />
          )}
          <button type="button" className="settings-pane__btn-ghost" onClick={doFetchModels}>获取模型</button>
        </div>
        {fetchMsg && <span className="settings-pane__hint">{fetchMsg}</span>}
      </label>

      <label className="settings-pane__field settings-pane__field--check">
        <input type="checkbox" checked={confirmTools} onChange={e => { setConfirmTools(e.target.checked); setStatus(""); }} />
        改动型工具执行前需确认
      </label>

      <section className="settings-pane__section">
        <div className="settings-pane__section-title">上下文与缓存</div>
        <label className="settings-pane__field settings-pane__field--check">
          <input
            type="checkbox"
            checked={promptCacheMode === "auto"}
            onChange={e => { setPromptCacheMode(e.target.checked ? "auto" : "off"); setStatus(""); }}
          />
          Provider 原生提示缓存
        </label>
        <label className="settings-pane__field">
          缓存时长
          <select
            value={promptCacheTtl}
            disabled={promptCacheMode === "off"}
            onChange={e => { setPromptCacheTtl(e.target.value); setStatus(""); }}
          >
            <option value="default">Provider 默认</option>
            <option value="5m">5 分钟</option>
            <option value="1h">1 小时</option>
          </select>
        </label>
        <label className="settings-pane__field">
          长会话策略
          <select value={contextStrategy} onChange={e => { setContextStrategy(e.target.value); setStatus(""); }}>
            <option value="projected">持久化上下文投影（推荐）</option>
            <option value="legacy">旧完整历史（兼容）</option>
          </select>
        </label>
        <span className="settings-pane__hint">完整对话始终保留；切换策略从下一轮生效。</span>
      </section>

      {error && <div className="settings-pane__error">{error}</div>}
      <div className="settings-pane__actions">
        <button type="button" onClick={save}>保存并使用</button>
        {status && <span className="settings-pane__saved">{status}</span>}
      </div>

      <p className="settings-pane__note">
        每条配置独立保存渠道、账号、模型和思考等级。Key 与旧版本一致，仅明文保存在本机浏览器 prefs，不会随会话导出。
      </p>
    </div>
  );
}

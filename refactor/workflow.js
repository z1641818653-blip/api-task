// ── State ──
let workflows = [];
let activeWorkflowId = null;
let selectedNodeId = null;
let copiedNode = null;
let draggedNodeId = null;
let abortController = null;
let isRunning = false;
let runQueue = [];
let runIndex = 0;
const WORKFLOW_HISTORY_KEY = 'wf_history_v2';
const LEGACY_WORKFLOW_HISTORY_KEY = 'wf_history_v1';
const MAX_WORKFLOW_HISTORY = 5;
let workflowVersionHistory = {};
let workflowVersionFuture = {};
let workflowVersionBaselines = {};
let versionHistoryInitialized = false;
let isRestoringWorkflowVersion = false;
const DEEPSEEK_MODELS = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash（快速测试）' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro（高质量）' }
];
let providerState = { provider: 'DeepSeek', model: 'deepseek-v4-flash', apiKey: '' };

function normalizeDeepSeekProviderState() {
  providerState.provider = 'DeepSeek';
  if (!DEEPSEEK_MODELS.some(function(item) { return item.id === providerState.model; })) {
    providerState.model = 'deepseek-v4-flash';
  }
}

function createNode(title, opts) {
  return {
    id: 'n' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    title: title || '',
    prompt: '',
    inputType: 'manual',
    inheritFrom: null,
    manualInput: '',
    output: '',
    status: 'pending',
    error: '',
    maxTokens: 4000,
    temperature: 0.3,
    color: '',
    children: [],
    _parentId: null,
    _collapsed: false,
    locked: false,
    ...opts
  };
}

const WORKFLOW_EXPORT_SCHEMA = 'linjin.workflow';
const WORKFLOW_EXPORT_VERSION = 2;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_NODES = 5000;

function parseStoredJson(raw, fallback, label, backupKey) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn((label || 'JSON') + ' 解析失败:', err);
    if (backupKey && typeof localStorage !== 'undefined') {
      try { localStorage.setItem(backupKey, raw); } catch (backupErr) {}
    }
    return fallback;
  }
}

function normalizeNodeData(node, parentId, seenIds, counter) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) node = createNode('新节点');
  seenIds = seenIds || new Set();
  counter = counter || { count: 0 };
  counter.count += 1;
  if (counter.count > MAX_IMPORT_NODES) throw new Error('节点数量超过上限 ' + MAX_IMPORT_NODES);

  if (typeof node.id !== 'string' || !node.id || seenIds.has(node.id)) node.id = createNode('').id;
  seenIds.add(node.id);
  node.title = typeof node.title === 'string' ? node.title : '';
  node.prompt = typeof node.prompt === 'string' ? node.prompt : '';
  node.inputType = typeof node.inputType === 'string' && node.inputType ? node.inputType : 'manual';
  node.inheritFrom = typeof node.inheritFrom === 'string' && node.inheritFrom ? node.inheritFrom : null;
  node.manualInput = typeof node.manualInput === 'string' ? node.manualInput : '';
  node.output = typeof node.output === 'string' ? node.output : '';
  node.status = typeof node.status === 'string' && node.status ? node.status : 'pending';
  if (node.status === 'running') node.status = 'pending';
  node.error = typeof node.error === 'string' ? node.error : '';
  node.maxTokens = Number.isFinite(Number(node.maxTokens)) && Number(node.maxTokens) > 0 ? Number(node.maxTokens) : 4000;
  node.temperature = Number.isFinite(Number(node.temperature)) ? Number(node.temperature) : 0.3;
  node.color = typeof node.color === 'string' ? node.color : '';
  node._collapsed = node._collapsed === true;
  node.locked = node.locked === true;
  node._parentId = parentId;
  node.children = Array.isArray(node.children) ? node.children.filter(function(child) {
    return child && typeof child === 'object' && !Array.isArray(child);
  }) : [];
  node.children = node.children.map(function(child) {
    return normalizeNodeData(child, node.id, seenIds, counter);
  });
  return node;
}

function normalizeWorkflowData(wf, index) {
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return null;
  if (typeof wf.id !== 'string' || !wf.id) wf.id = 'wf_' + Date.now() + '_' + (index || 0) + '_' + Math.random().toString(36).slice(2,6);
  wf.title = typeof wf.title === 'string' && wf.title ? wf.title : '未命名流程';
  wf.createdAt = typeof wf.createdAt === 'string' ? wf.createdAt : new Date().toISOString();
  wf.updatedAt = typeof wf.updatedAt === 'string' ? wf.updatedAt : wf.createdAt;
  if (!wf.tree || typeof wf.tree !== 'object' || Array.isArray(wf.tree)) wf.tree = createNode('流程根节点');
  wf.tree = normalizeNodeData(wf.tree, null, new Set(), { count: 0 });
  ensureMainNode(wf);
  repairInternalRootReferences(wf);
  return wf;
}

function normalizeWorkflowList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(function(wf, index) { return normalizeWorkflowData(wf, index); }).filter(Boolean);
}

function buildWorkflowExport(wf) {
  wf = normalizeWorkflowData(wf, 0);
  if (!wf) throw new Error('当前流程无效');
  return {
    schema: WORKFLOW_EXPORT_SCHEMA,
    version: WORKFLOW_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workflow: {
      title: wf.title,
      createdAt: wf.createdAt,
      updatedAt: wf.updatedAt,
      tree: JSON.parse(JSON.stringify(wf.tree))
    },
    provider: {
      provider: providerState.provider,
      model: providerState.model
    }
  };
}

function readWorkflowImport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('导入文件必须是 JSON 对象');
  if (data.schema && data.schema !== WORKFLOW_EXPORT_SCHEMA) throw new Error('不支持的流程文件类型');
  if (data.version && Number(data.version) > WORKFLOW_EXPORT_VERSION) throw new Error('流程文件版本过新，请升级页面后再导入');

  var source = data.workflow && typeof data.workflow === 'object' ? data.workflow : data;
  if (!source.tree || typeof source.tree !== 'object' || Array.isArray(source.tree)) throw new Error('导入文件缺少有效的 tree');
  return {
    title: typeof source.title === 'string' ? source.title : null,
    createdAt: typeof source.createdAt === 'string' ? source.createdAt : null,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    tree: source.tree,
    provider: data.provider && typeof data.provider === 'object' ? data.provider : null
  };
}

function getImportTitleFromFile(fileName) {
  var name = typeof fileName === 'string' ? fileName.trim() : '';
  return name.replace(/\.workflow\.json$/i, '').replace(/\.json$/i, '') || '导入流程';
}

function getUniqueWorkflowTitle(title) {
  var base = typeof title === 'string' && title.trim() ? title.trim() : '导入流程';
  var existing = new Set(workflows.map(function(wf) { return wf.title; }));
  if (!existing.has(base)) return base;
  var match = base.match(/^(.*)（(\d+)）$/);
  var root = match && match[1] ? match[1] : base;
  var index = 1;
  while (existing.has(root + '（' + index + '）')) index += 1;
  return root + '（' + index + '）';
}

function applyWorkflowImport(data, fileName) {
  var imported = readWorkflowImport(data);
  var now = new Date().toISOString();
  var wf = {
    id: 'wf_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    title: getUniqueWorkflowTitle(imported.title || getImportTitleFromFile(fileName)),
    tree: imported.tree,
    createdAt: now,
    updatedAt: now
  };
  normalizeWorkflowData(wf, workflows.length);

  if (imported.provider && typeof imported.provider.model === 'string') {
    providerState.model = imported.provider.model;
  }
  normalizeDeepSeekProviderState();

  workflows.push(wf);
  activeWorkflowId = wf.id;
  var mainNode = ensureMainNode(wf);
  selectedNodeId = mainNode ? mainNode.id : null;
  return wf;
}

function getActiveWorkflow(){return workflows.find(w=>w.id===activeWorkflowId);}

function getMainNode(wf) {
  if (!wf || !wf.tree || !Array.isArray(wf.tree.children)) return null;
  return wf.tree.children.find(function(n) { return n && n._isMainNode === true; }) || wf.tree.children[0] || null;
}

function ensureMainNode(wf) {
  if (!wf) return null;
  if (!wf.tree || typeof wf.tree !== 'object') wf.tree = createNode('流程根节点');
  if (!Array.isArray(wf.tree.children)) wf.tree.children = [];
  var mainNode = getMainNode(wf);
  if (!mainNode) {
    mainNode = createNode('主任务');
    wf.tree.children.unshift(mainNode);
  } else {
    var mainIndex = wf.tree.children.indexOf(mainNode);
    if (mainIndex > 0) {
      wf.tree.children.splice(mainIndex, 1);
      wf.tree.children.unshift(mainNode);
    }
  }
  mainNode._isMainNode = true;
  mainNode.inputType = 'manual';
  mainNode.inheritFrom = null;
  if (!mainNode.title) mainNode.title = '主任务';
  (function clearDuplicateMainMarkers(node) {
    if (!node || !Array.isArray(node.children)) return;
    node.children.forEach(function(child) {
      if (child !== mainNode && child && child._isMainNode === true) delete child._isMainNode;
      clearDuplicateMainMarkers(child);
    });
  })(wf.tree);
  updateParentRefs(wf.tree, null);
  return mainNode;
}

function isMainNode(wf, nodeOrId) {
  if (!wf || !nodeOrId) return false;
  var node = typeof nodeOrId === 'string' ? findNode(wf.tree, nodeOrId) : nodeOrId;
  if (!node) return false;
  var mainNode = getMainNode(wf);
  return node._isMainNode === true || !!(mainNode && mainNode.id === node.id);
}

function repairInternalRootReferences(wf) {
  if (!wf || !wf.tree) return;
  (function walk(node) {
    if (!node) return;
    if (node !== wf.tree && node.inheritFrom === wf.tree.id) {
      node.inheritFrom = null;
      if (node.inputType === 'inherit') node.inputType = 'manual';
    }
    (node.children || []).forEach(walk);
  })(wf.tree);
}

// ── Tree operations ──
function findNode(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  for (const c of root.children) {
    const found = findNode(c, id);
    if (found) return found;
  }
  return null;
}

function findParent(root, id, parent) {
  if (!root) return null;
  if (root.id === id) return parent;
  for (const c of root.children) {
    const found = findParent(c, id, root);
    if (found) return found;
  }
  return null;
}

function getAncestors(root, id, acc) {
  acc = acc || [];
  if (!root) return acc;
  if (root.id === id) return acc;
  for (const c of root.children) {
    if (findNode(c, id)) {
      acc.push(root);
      return getAncestors(c, id, acc);
    }
  }
  return acc;
}

function getPathIdx(root, id) {
  const path = [];
  (function walk(node, indices) {
    if (node.id === id) { path.push(...indices); return true; }
    for (let i = 0; i < node.children.length; i++) {
      if (walk(node.children[i], [...indices, i])) return true;
    }
    return false;
  })(root, []);
  return path;
}

function getNodePath(root, id) {
  const idx = getPathIdx(root, id);
  return idx.map(i => i + 1).join('.');
}

function updateParentRefs(node, parentId) {
  if (!node || typeof node !== 'object') return;
  if (!Array.isArray(node.children)) node.children = [];
  node._parentId = parentId;
  for (const c of node.children) updateParentRefs(c, node.id);
}

function addChild(parentId, title) {
  var wf = getActiveWorkflow();
  if (!wf) return null;
  ensureMainNode(wf);
  const parent = findNode(wf.tree, parentId);
  if (!parent) return null;
  const node = createNode(title || '新节点');
  node._parentId = parentId;
  parent.children.push(node);
  saveState();
  renderAll();
  return node.id;
}

function hasLockedDescendant(node) {
  if (node.locked) return true;
  for (const c of node.children) {
    if (hasLockedDescendant(c)) return true;
  }
  return false;
}
function replaceInheritedNodeReference(node, oldId, newId) {
  if (!node) return;
  if (node.inheritFrom === oldId) node.inheritFrom = newId || null;
  (node.children || []).forEach(function(child) {
    replaceInheritedNodeReference(child, oldId, newId);
  });
}

function deleteCurrentNode(nodeId) {
  var wf = getActiveWorkflow();
  if (!wf) return;
  const node = findNode(wf.tree, nodeId);
  if (!node) return;
  if (isMainNode(wf, node)) { showToast('主节点是流程锚点，不能删除', 'warning'); return; }
  if (node.locked) { showToast('锁定节点不能删除', 'warning'); return; }
  const childCount = (node.children || []).length;
  const message = childCount > 0
    ? '仅删除当前节点“' + (node.title || '未命名') + '”吗？它的 ' + childCount + ' 个直接子节点将自动提升到上一级。'
    : '确定删除当前节点“' + (node.title || '未命名') + '”吗？';
  showConfirm(message, function() {
    doDeleteCurrentNode(nodeId);
  });
}

function doDeleteCurrentNode(nodeId) {
  var wf = getActiveWorkflow();
  if (!wf) return;
  var mainNode = ensureMainNode(wf);
  const node = findNode(wf.tree, nodeId);
  if (!node) return;
  if (isMainNode(wf, node)) {
    selectedNodeId = mainNode ? mainNode.id : null;
    showToast('主节点是流程锚点，不能删除', 'warning');
    return;
  }
  if (node.locked) { showToast('锁定节点不能删除', 'warning'); return; }
  const parent = findParent(wf.tree, nodeId);
  if (!parent) return;
  const idx = parent.children.findIndex(function(child) { return child.id === nodeId; });
  if (idx === -1) return;
  const promotedChildren = (node.children || []).slice();
  promotedChildren.forEach(function(child) {
    child._parentId = parent.id;
    replaceInheritedNodeReference(child, nodeId, parent.id);
  });
  parent.children.splice.apply(parent.children, [idx, 1].concat(promotedChildren));
  selectedNodeId = parent.id;
  saveState();
  renderAll();
  showToast(promotedChildren.length ? '当前节点已删除，子节点已连接到上一级' : '节点已删除', 'success');
}

function deleteNode(nodeId) {
  var wf = getActiveWorkflow();
  if (!wf) return;
  const node = findNode(wf.tree, nodeId);
  if (!node) return;
  if (isMainNode(wf, node)) { showToast('主节点是流程锚点，不能删除', 'warning'); return; }
  if (node.locked) { showToast('锁定节点不能删除', 'warning'); return; }
  const totalCount = dfsNodes(node).length;
  const lockedWarning = hasLockedDescendant(node) ? '其中包含锁定子节点。' : '';
  showConfirm(
    '确定删除分支“' + (node.title || '未命名') + '”吗？将删除共 ' + totalCount + ' 个节点。' + lockedWarning,
    function() { doDeleteNode(nodeId); }
  );
}
function doDeleteNode(nodeId) {
  var wf = getActiveWorkflow();
  if (!wf) return;
  var mainNode = ensureMainNode(wf);
  if (isMainNode(wf, nodeId)) {
    selectedNodeId = mainNode ? mainNode.id : null;
    showToast('主节点是流程锚点，不能删除', 'warning');
    return;
  }
  const parent = findParent(wf.tree, nodeId);
  if (!parent) return;
  const idx = parent.children.findIndex(c => c.id === nodeId);
  if (idx !== -1) parent.children.splice(idx, 1);
  if (selectedNodeId === nodeId) selectedNodeId = parent.id;
  saveState();
  renderAll();
  showToast('分支已删除', 'success');
}

function removeNodeFromParent(root, nodeId) {
  if (!root) return null;
  for (let i = 0; i < root.children.length; i++) {
    if (root.children[i].id === nodeId) {
      if (root.children[i]._isMainNode === true) return null;
      return root.children.splice(i, 1)[0];
    }
    const found = removeNodeFromParent(root.children[i], nodeId);
    if (found) return found;
  }
  return null;
}

function validateNodeMove(wf, nodeId, targetId, mode) {
  if (!wf || !nodeId || !targetId || nodeId === targetId) {
    showToast('不能移动到当前节点', 'warning');
    return null;
  }
  ensureMainNode(wf);
  var node = findNode(wf.tree, nodeId);
  var target = findNode(wf.tree, targetId);
  if (!node || !target) {
    showToast('移动目标不存在', 'error');
    return null;
  }
  if (isMainNode(wf, node)) {
    showToast('主节点不能移动', 'warning');
    return null;
  }
  if (node.locked) {
    showToast('锁定节点不能移动', 'warning');
    return null;
  }
  if (findNode(node, targetId)) {
    showToast('不能移动到自己的子节点中', 'warning');
    return null;
  }
  if ((mode === 'before' || mode === 'after') && isMainNode(wf, target)) {
    showToast('主节点不能创建同级节点', 'warning');
    return null;
  }
  var targetParent = mode === 'child' ? null : findParent(wf.tree, targetId);
  if (mode !== 'child' && !targetParent) {
    showToast('无法确定目标位置', 'error');
    return null;
  }
  return { node: node, target: target, targetParent: targetParent };
}

function finishNodeMove(node, parentId) {
  updateParentRefs(node, parentId);
  saveState();
  renderAll();
  return true;
}

function moveNodeBefore(nodeId, targetId) {
  var wf = getActiveWorkflow();
  var move = validateNodeMove(wf, nodeId, targetId, 'before');
  if (!move) return false;
  var node = removeNodeFromParent(wf.tree, nodeId);
  if (!node) return false;
  var targetIndex = move.targetParent.children.findIndex(function(child) { return child.id === targetId; });
  if (targetIndex < 0) return false;
  move.targetParent.children.splice(targetIndex, 0, node);
  return finishNodeMove(node, move.targetParent.id);
}

function moveNodeAfter(nodeId, targetId) {
  var wf = getActiveWorkflow();
  var move = validateNodeMove(wf, nodeId, targetId, 'after');
  if (!move) return false;
  var node = removeNodeFromParent(wf.tree, nodeId);
  if (!node) return false;
  var targetIndex = move.targetParent.children.findIndex(function(child) { return child.id === targetId; });
  if (targetIndex < 0) return false;
  move.targetParent.children.splice(targetIndex + 1, 0, node);
  return finishNodeMove(node, move.targetParent.id);
}

function moveNodeAsChild(nodeId, targetId) {
  var wf = getActiveWorkflow();
  var move = validateNodeMove(wf, nodeId, targetId, 'child');
  if (!move) return false;
  var node = removeNodeFromParent(wf.tree, nodeId);
  if (!node) return false;
  move.target.children.push(node);
  if (move.target._collapsed) move.target._collapsed = false;
  return finishNodeMove(node, move.target.id);
}

function countDescendants(node) {
  let count = 1;
  for (const c of node.children) count += countDescendants(c);
  return count;
}

function dfsNodes(node, acc) {
  acc = acc || [];
  acc.push(node);
  for (const c of node.children) dfsNodes(c, acc);
  return acc;
}

function copyNode(nodeId) {
  var wf = getActiveWorkflow();
  if (!wf) return;
  ensureMainNode(wf);
  const node = findNode(wf.tree, nodeId);
  if (!node) return;
  copiedNode = JSON.parse(JSON.stringify(node));
  showToast('节点已复制', 'success');
}

function pasteNode(targetId) {
  if (!copiedNode) { showToast('没有已复制的节点', 'warning'); return; }
  var wf = getActiveWorkflow();
  if (!wf) return;
  const target = findNode(wf.tree, targetId);
  if (!target) { showToast('目标节点不存在', 'error'); return; }
  const newNode = JSON.parse(JSON.stringify(copiedNode));
  (function prepareCopiedNode(n, parentId) {
    n.id = 'n' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
    n._parentId = parentId;
    delete n._isMainNode;
    n.status = 'pending';
    n.output = '';
    n.error = '';
    if (!Array.isArray(n.children)) n.children = [];
    for (const c of n.children) prepareCopiedNode(c, n.id);
  })(newNode, target.id);
  target.children.push(newNode);
  if (target._collapsed) target._collapsed = false;
  saveState();
  renderAll();
  selectedNodeId = newNode.id;
  renderAll();
  showToast('节点已粘贴', 'success');
}

function toggleNodeLock(id) {
  var wf = getActiveWorkflow();
  if (!wf) return;
  ensureMainNode(wf);
  var n = findNode(wf.tree, id);
  if (!n) return;
  n.locked = !n.locked;
  saveState();
  renderAll();
}

// ── Provider configs ──
const PROVIDERS = {
  DeepSeek: {
    endpoint: 'https://api.deepseek.com/chat/completions',
    buildBody: (model, prompt, maxTokens, temperature) => ({
      model: model || 'deepseek-v4-flash',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      max_tokens: maxTokens,
      temperature
    }),
    buildHeaders: (apiKey) => ({ 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }),
    parse: (data) => data.choices?.[0]?.delta?.content || data.choices?.[0]?.text || ''
  },
  OpenAI: {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    buildBody: (model, prompt, maxTokens, temperature) => ({
      model: model || 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      max_tokens: maxTokens,
      temperature
    }),
    buildHeaders: (apiKey) => ({ 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }),
    parse: (data) => data.choices?.[0]?.delta?.content || data.choices?.[0]?.text || ''
  },
  Claude: {
    endpoint: 'https://api.anthropic.com/v1/messages',
    buildBody: (model, prompt, maxTokens, temperature) => ({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      temperature
    }),
    buildHeaders: (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }),
    parse: (data) => data.type === 'content_block_delta' ? (data.delta?.text || '') : ''
  },
  Gemini: {
    getUrl: (model, apiKey) => `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:streamGenerateContent?alt=sse&key=${apiKey}`,
    buildBody: (model, prompt, maxTokens, temperature) => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature }
    }),
    buildHeaders: () => ({ 'Content-Type': 'application/json' }),
    parse: (data) => data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  },
  '千问': {
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    buildBody: (model, prompt, maxTokens, temperature) => ({
      model: model || 'qwen-turbo',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      max_tokens: maxTokens,
      temperature
    }),
    buildHeaders: (apiKey) => ({ 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' }),
    parse: (data) => data.choices?.[0]?.delta?.content || data.choices?.[0]?.text || ''
  }
};

// ── Execution validation and SSE execution ──
function hasNodeText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getNodeConfigurationIssue(wf, node) {
  if (!wf || !node) return { level: 'error', reason: '节点不存在' };
  var inputValid = false;
  var inputReason = '';
  if (isMainNode(wf, node) || node.inputType === 'manual') {
    inputValid = hasNodeText(node.manualInput);
    inputReason = '手动输入为空';
  } else if (node.inputType === 'inherit') {
    var source = node.inheritFrom ? findNode(wf.tree, node.inheritFrom) : null;
    var ancestors = getAncestors(wf.tree, node.id).filter(function(ancestor) {
      return ancestor.id !== wf.tree.id;
    });
    inputValid = !!(source && ancestors.some(function(ancestor) { return ancestor.id === source.id; }));
    inputReason = node.inheritFrom ? '继承来源无效' : '尚未选择继承来源';
  } else {
    inputReason = '输入来源无效';
  }
  if (!inputValid) return { level: 'error', reason: inputReason };
  if (!hasNodeText(node.prompt)) return { level: 'warning', reason: 'Prompt 为空' };
  return null;
}

function collectExecutionIssues(wf, nodes, mode) {
  var byNode = {};
  (nodes || []).forEach(function(node) {
    var issue = getNodeConfigurationIssue(wf, node);
    if (issue) byNode[node.id] = { node: node, level: issue.level, reason: issue.reason };
  });
  if (mode === 'single' && nodes && nodes[0]) {
    var current = nodes[0];
    var incompleteAncestors = getAncestors(wf.tree, current.id).filter(function(ancestor) {
      return ancestor.id !== wf.tree.id && (ancestor.status !== 'done' || !hasNodeText(ancestor.output));
    });
    if (incompleteAncestors.length) {
      byNode[current.id] = {
        node: current,
        level: 'error',
        reason: '上级节点尚未全部完成并产生输出'
      };
    }
  }
  return Object.keys(byNode).map(function(id) { return byNode[id]; });
}

function showExecutionChoice(issues, onForce) {
  var redCount = issues.filter(function(issue) { return issue.level === 'error'; }).length;
  var blueCount = issues.filter(function(issue) { return issue.level === 'warning'; }).length;
  var samples = issues.slice(0, 3).map(function(issue) {
    return '“' + (issue.node.title || '未命名') + '”：' + issue.reason;
  }).join('；');
  var message = '检测到 ' + redCount + ' 个红色问题、' + blueCount + ' 个蓝色提醒。' +
    (samples ? samples + '。' : '') + '请选择返回完善流程，或强制执行。';
  var overlay = document.getElementById('confirmOverlay');
  var msg = document.getElementById('confirmMsg');
  var yes = document.getElementById('confirmYes');
  var no = document.getElementById('confirmNo');
  var oldYes = yes.textContent;
  var oldNo = no.textContent;
  msg.textContent = message;
  yes.textContent = '强制执行';
  no.textContent = '返回完善';
  overlay.style.display = 'flex';
  function closeChoice() {
    overlay.style.display = 'none';
    yes.removeEventListener('click', forceExecution);
    no.removeEventListener('click', closeChoice);
    yes.textContent = oldYes;
    no.textContent = oldNo;
  }
  function forceExecution() {
    closeChoice();
    onForce();
  }
  yes.addEventListener('click', forceExecution);
  no.addEventListener('click', closeChoice);
}

function getDependencyChain(wf, node) {
  if (!wf || !node) return [];
  return getAncestors(wf.tree, node.id).filter(function(ancestor) {
    return ancestor.id !== wf.tree.id;
  }).concat([node]);
}

function prepareExecution(nodes, mode, force) {
  if (isRunning) { showToast('正在执行中', 'warning'); return; }
  var wf = getActiveWorkflow();
  if (!wf || !nodes || !nodes.length) return;
  var issueNodes = mode === 'dependencies' ? nodes.filter(function(node, index) {
    return index === nodes.length - 1 || node.status !== 'done' || !hasNodeText(node.output) ||
           !!getNodeConfigurationIssue(wf, node);
  }) : nodes;
  var issues = collectExecutionIssues(wf, issueNodes, mode);
  if (issues.length && !force) {
    showExecutionChoice(issues, function() {
      prepareExecution(nodes, mode, true);
    });
    return;
  }
  runExecutionQueue(nodes, { mode: mode, force: !!force });
}

function executeNode(nodeId, force) {
  var wf = getActiveWorkflow();
  var node = wf ? findNode(wf.tree, nodeId) : null;
  if (!node) return;
  prepareExecution([node], 'single', force);
}

function runDependencyChain(nodeId, force) {
  var wf = getActiveWorkflow();
  var node = wf ? findNode(wf.tree, nodeId) : null;
  if (!node) return;
  prepareExecution(getDependencyChain(wf, node), 'dependencies', force);
}

function runCascade(nodeId, force) {
  return runDependencyChain(nodeId, force);
}

function executeAll(force) {
  var wf = getActiveWorkflow();
  var mainNode = wf ? ensureMainNode(wf) : null;
  if (!mainNode) return;
  prepareExecution(dfsNodes(mainNode), 'all', force);
}

async function runExecutionQueue(nodes, options) {
  if (isRunning) { showToast('正在执行中', 'warning'); return; }
  var wf = getActiveWorkflow();
  if (!wf || !nodes || !nodes.length) return;
  if (!providerState.apiKey) { showToast('请先设置 API Key', 'warning'); return; }
  var provider = PROVIDERS[providerState.provider];
  if (!provider) { showToast('当前 Provider 不可用', 'error'); return; }

  isRunning = true;
  abortController = new AbortController();
  runQueue = nodes.map(function(node) { return node.id; });
  runIndex = 0;
  var reusableDependencyIds = {};
  nodes.forEach(function(node, index) {
    var reusable = options.mode === 'dependencies' && index < nodes.length - 1 &&
      node.status === 'done' && hasNodeText(node.output) && !getNodeConfigurationIssue(wf, node);
    if (reusable) {
      reusableDependencyIds[node.id] = true;
    } else {
      node.status = 'pending';
      node.output = '';
      node.error = '';
    }
  });
  renderAll();
  updateProgress(0, nodes.length, '');
  updateBottomBar();

  try {
    for (var i = 0; i < nodes.length; i++) {
      if (abortController && abortController.signal.aborted) {
        for (var stoppedIndex = i; stoppedIndex < nodes.length; stoppedIndex++) {
          if (nodes[stoppedIndex].status === 'pending') nodes[stoppedIndex].status = 'stopped';
        }
        break;
      }
      runIndex = i;
      var node = nodes[i];
      var nodeId = node.id;

      if (reusableDependencyIds[nodeId]) {
        updateProgress(i + 1, nodes.length, '复用：' + (node.title || '未命名'));
        updateBottomBar();
        continue;
      }

      if (options.mode !== 'single') {
        var unmet = getAncestors(wf.tree, nodeId).filter(function(ancestor) {
          return ancestor.id !== wf.tree.id && (ancestor.status !== 'done' || !hasNodeText(ancestor.output));
        });
        if (unmet.length) {
          node.status = 'blocked';
          node.output = '';
          node.error = '前置节点未完成或没有输出：' + unmet.map(function(item) {
            return item.title || '未命名';
          }).join('、');
          saveState();
          renderAll();
          updateProgress(i + 1, nodes.length, '');
          continue;
        }
      }

      var actualPrompt = node.prompt || '';
      if ((isMainNode(wf, node) || node.inputType === 'manual') && hasNodeText(node.manualInput)) {
        actualPrompt = node.manualInput + (hasNodeText(node.prompt) ? '\n\n' + node.prompt : '');
      } else if (node.inputType === 'inherit' && node.inheritFrom) {
        var source = findNode(wf.tree, node.inheritFrom);
        if (source && hasNodeText(source.output)) {
          actualPrompt = source.output + (hasNodeText(node.prompt) ? '\n\n' + node.prompt : '');
        }
      }

      node.status = 'running';
      node.output = '';
      node.error = '';
      selectedNodeId = nodeId;
      renderAll();
      updateProgress(i, nodes.length, node.title || '未命名');
      updateBottomBar();

      try {
        var model = providerState.model || '';
        var url = provider.getUrl ? provider.getUrl(model, providerState.apiKey) : provider.endpoint;
        var headers = provider.buildHeaders(providerState.apiKey);
        var body = provider.buildBody(model, actualPrompt || 'Hello', node.maxTokens, node.temperature);
        var parseFn = provider.parse;
        var response = await fetch(url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
          signal: abortController.signal
        });
        if (!response.ok) {
          var errText = await response.text().catch(function() { return ''; });
          throw new Error('HTTP ' + response.status + (errText ? ': ' + errText.slice(0, 200) : ''));
        }

        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var accumulated = '';
        while (true) {
          var readResult = await reader.read();
          if (readResult.done) break;
          buffer += decoder.decode(readResult.value, { stream: true });
          var parts = buffer.split('\n');
          buffer = parts.pop() || '';
          for (var partIndex = 0; partIndex < parts.length; partIndex++) {
            var line = parts[partIndex];
            if (!line.startsWith('data: ')) continue;
            var payload = line.slice(5).trim();
            if (payload === '[DONE]' || payload === '[done]') continue;
            try {
              var parsed = JSON.parse(payload);
              var text = parseFn(parsed);
              if (text) {
                accumulated += text;
                node.output = accumulated;
                updateOutputDisplay(nodeId);
              }
            } catch (parseError) {}
          }
        }
        if (!hasNodeText(node.output)) throw new Error('模型未返回有效输出');
        node.status = 'done';
      } catch (error) {
        if (error.name === 'AbortError') {
          node.status = 'stopped';
        } else {
          node.status = 'error';
          node.error = error.message;
        }
      }
      saveState();
      renderAll();
      updateProgress(i + 1, nodes.length, '');
    }
  } finally {
    isRunning = false;
    abortController = null;
    runIndex = runQueue.length;
    saveState();
    renderAll();
    updateBottomBar();
  }
}

function stopExecution() {
  if (abortController && !abortController.signal.aborted) {
    abortController.abort();
    showToast('正在停止执行', 'info');
  }
}

function updateOutputDisplay(nodeId) {
  if (selectedNodeId !== nodeId) return;
  const el = document.getElementById('nodeOutput');
  var wf = getActiveWorkflow();
  if (!wf) return;
  const node = findNode(wf.tree, nodeId);
  if (el && node) el.value = node.output || '';
}

function updateBottomBar() {
  const el = document.getElementById('bottomBar');
  if (runQueue.length && runIndex < runQueue.length) {
    el.textContent = '⏳ 执行中: ' + (runIndex + 1) + '/' + runQueue.length;
  } else {
    runQueue = [];
    runIndex = 0;
    el.textContent = '';
  }
}

function updateProgress(current, total, label) {
  var progress = document.getElementById('execProgress');
  var textEl = document.getElementById('execProgressText');
  var barEl = document.getElementById('execProgressBar');
  if (!progress || !textEl || !barEl) return;
  progress.hidden = !isRunning;
  if (current >= total && total > 0) {
    textEl.textContent = '全部完成 (' + total + '/' + total + ')';
  } else if (label) {
    textEl.textContent = '执行中: ' + label + ' (' + current + '/' + total + ')';
  } else {
    textEl.textContent = '执行中: ' + current + '/' + total;
  }
  barEl.style.width = (total > 0 ? (current / total * 100) : 0) + '%';
}

// ── Toast ──
function showConfirm(msg, cb) {
  var o=document.getElementById('confirmOverlay'),m=document.getElementById('confirmMsg');
  m.textContent=msg;o.style.display='flex';
  var y=document.getElementById('confirmYes'),n=document.getElementById('confirmNo');
  function cl(){o.style.display='none';y.removeEventListener('click',onY);n.removeEventListener('click',cl);}
  function onY(){cl();cb();}
  y.addEventListener('click',onY);n.addEventListener('click',cl);
}

function showToast(msg, type) {
  type = type || 'info';
  const container = document.getElementById('toastContainer');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => {
    t.classList.add('removing');
    setTimeout(() => t.remove(), 260);
  }, 3000);
}

// ── Context Menu ──
function showContextMenu(e, nodeId) {
  e.preventDefault();
  const menu = document.getElementById('contextMenu');
  menu.innerHTML =
    '<div class="ctx-item" data-action="ctxCopy" data-id="' + nodeId + '">📋 复制节点</div>' +
    '<div class="ctx-item" data-action="ctxPaste" data-id="' + nodeId + '">📥 粘贴到此处</div>' +
    '<div class="ctx-divider"></div>' +
    '<div class="ctx-item" data-action="ctxAdd" data-id="' + nodeId + '">➕ 添加子节点</div>' +
    '<div class="ctx-item" data-action="ctxDeleteCurrent" data-id="' + nodeId + '">✂ 仅删除当前</div>' +
    '<div class="ctx-item" data-action="ctxDeleteBranch" data-id="' + nodeId + '">✕ 删除整个分支</div>';
  menu.style.display = 'block';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 160) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 160) + 'px';
}

document.addEventListener('click', function() {
  document.getElementById('contextMenu').style.display = 'none';
});

document.getElementById('contextMenu').addEventListener('click', function(e) {
  const item = e.target.closest('.ctx-item');
  if (!item) return;
  const nodeId = item.dataset.id;
  const action = item.dataset.action;
  var wf = getActiveWorkflow();
  var ctxNode = wf ? findNode(wf.tree, nodeId) : null;
  if (action === 'ctxCopy') { copyNode(nodeId); }
  else if (action === 'ctxPaste') { pasteNode(nodeId); }
  else if (action === 'ctxAdd') { addChild(nodeId); }
  else if (action === 'ctxDeleteCurrent') {
    if (ctxNode && ctxNode.locked) { showToast('锁定节点不能删除', 'warning'); }
    else { deleteCurrentNode(nodeId); }
  }
  else if (action === 'ctxDeleteBranch') {
    if (ctxNode && ctxNode.locked) { showToast('锁定节点不能删除', 'warning'); }
    else { deleteNode(nodeId); }
  }
  this.style.display = 'none';
});

// ── Render functions ──
function renderAll() {
  renderSettings();
  renderWorkspace();
  renderTree();
  updateWfNameInput();
  updateTreeActionButtons();
  updateVersionControls();
}

function updateTreeActionButtons() {
  var executeTreeBtn = document.querySelector('#treeButtons .btn[data-action="executeTree"]');
  if (executeTreeBtn) {
    executeTreeBtn.disabled = isRunning;
    executeTreeBtn.title = isRunning ? '流程正在执行' : '从主节点开始运行整个流程树';
  }
  var deleteBtns = document.querySelectorAll('#treeButtons .btn[data-action="deleteCurrent"],#treeButtons .btn[data-action="deleteNode"]');
  if (!deleteBtns.length) return;
  var wf = getActiveWorkflow();
  var selectedNode = wf && selectedNodeId ? findNode(wf.tree, selectedNodeId) : null;
  var deleteBlocked = !!(selectedNode && (isMainNode(wf, selectedNode) || selectedNode.locked));
  var title = selectedNode && isMainNode(wf, selectedNode) ? '主节点不可删除' :
              selectedNode && selectedNode.locked ? '锁定节点不能删除' : '';
  deleteBtns.forEach(function(deleteBtn) {
    deleteBtn.disabled = deleteBlocked;
    deleteBtn.title = title;
  });
}

function renderSettings() {
  const body = document.getElementById('settingsBody');
  const p = providerState;
  normalizeDeepSeekProviderState();
  body.innerHTML =
    '<div class="form-group">' +
      '<label class="form-label">Provider</label>' +
      '<input class="form-input" value="DeepSeek" disabled title="测试阶段仅启用 DeepSeek">' +
    '</div>' +
    '<div class="form-group">' +
      '<label class="form-label">Model</label>' +
      '<select class="form-select" id="selModel">' +
        DEEPSEEK_MODELS.map(function(item) {
          return '<option value="' + item.id + '"' + (p.model === item.id ? ' selected' : '') + '>' + item.label + '</option>';
        }).join('') +
      '</select>' +
    '</div>' +
    '<div class="form-group">' +
      '<label class="form-label">API Key</label>' +
      '<input class="form-input" id="inpApiKey" type="password" value="' + esc(p.apiKey) + '">' +
    '</div>' +
    '<div class="settings-actions">' +
      '<button class="btn btn-sm" id="btnExport">📤 导出流程</button>' +
      '<button class="btn btn-sm" id="btnImport">📥 导入流程</button>' +
    '</div>' +
    '<input class="visually-hidden" type="file" id="importInput" accept=".json">';

  document.getElementById('selModel').addEventListener('change', function() {
    providerState.model = this.value;
    normalizeDeepSeekProviderState();
    markAllWorkflowOutputsStale();
    saveState();
    renderAll();
  });
  document.getElementById('inpApiKey').addEventListener('change', function() {
    providerState.apiKey = this.value;
    localStorage.setItem('dk30', this.value);
    saveState();
  });
  document.getElementById('btnExport').addEventListener('click', function() {
    try {
      var wf = getActiveWorkflow();
      if (!wf) throw new Error('当前没有可导出的流程');
      var exportData = buildWorkflowExport(wf);
      const data = JSON.stringify(exportData, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = (wf.title || 'workflow').replace(/[\\/:*?"<>|]+/g, '_') + '.workflow.json';
      a.click();
      setTimeout(function() { URL.revokeObjectURL(url); }, 0);
      showToast('流程已导出（不包含 API Key）', 'success');
    } catch (err) {
      showToast('导出失败: ' + err.message, 'error');
    }
  });
  document.getElementById('btnImport').addEventListener('click', function() {
    document.getElementById('importInput').click();
  });
  document.getElementById('importInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      showToast('导入失败: 文件不能超过 5MB', 'error');
      this.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = function(ev) {
      try {
        const data = JSON.parse(ev.target.result);
        var importedWorkflow = applyWorkflowImport(data, file.name);
        if (!saveState()) throw new Error('导入内容无法保存到浏览器');
        renderWorkflowList();
        renderAll();
        showToast('已导入为新流程：' + importedWorkflow.title + '，API Key 保持当前设置', 'success');
      } catch(err) {
        showToast('导入失败: ' + err.message, 'error');
      }
    };
    reader.onerror = function() {
      showToast('导入失败: 无法读取文件', 'error');
    };
    reader.readAsText(file);
    this.value = '';
  });
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return esc(s); }

function renderWorkspace() {
  const content = document.getElementById('workspaceContent');
  const pathEl = document.getElementById('nodePath');
  const titleEl = document.getElementById('nodeTitleDisplay');
  var wf = getActiveWorkflow();
  var protectedMainNode = ensureMainNode(wf);
  if (wf && (!selectedNodeId || selectedNodeId === wf.tree.id || !findNode(wf.tree, selectedNodeId))) {
    selectedNodeId = protectedMainNode ? protectedMainNode.id : null;
  }
  const node = wf && selectedNodeId ? findNode(wf.tree, selectedNodeId) : null;

  if (!node) {
    content.innerHTML = '<div class="placeholder">请选择一个节点</div>';
    if (pathEl) pathEl.textContent = '📌 节点';
    if (titleEl) titleEl.textContent = '';
    return;
  }

  const path = getNodePath(wf.tree, node.id);
  if (pathEl) pathEl.textContent = '📌 节点 ' + path;
  if (titleEl) titleEl.textContent = node.title || '(未命名)';

  const ancestors = getAncestors(wf.tree, node.id).filter(function(ancestor) {
    return ancestor.id !== wf.tree.id;
  });
  let inheritOpts = '<option value="">— 选择上级 —</option>';
  for (const a of ancestors) {
    const ap = getNodePath(wf.tree, a.id);
    inheritOpts += '<option value="' + a.id + '"' + (node.inheritFrom === a.id ? ' selected' : '') + '>' + ap + ' ' + esc(a.title || '未命名') + '</option>';
  }

  const colorList = ['','red','orange','yellow','green','teal','cyan','blue','indigo','purple','pink','gray'];
  const colorLabels = { '':'无', 'red':'红', 'orange':'橙', 'yellow':'黄', 'green':'绿', 'teal':'青绿', 'cyan':'青', 'blue':'蓝', 'indigo':'靛蓝', 'purple':'紫', 'pink':'粉', 'gray':'灰' };
  let colorHtml = '<div class="color-picker">';
  for (const c of colorList) {
    colorHtml += '<div class="color-btn ' + (c || 'none') + (node.color === c ? ' active' : '') + '" data-color="' + c + '" title="' + colorLabels[c] + '"></div>';
  }
  colorHtml += '</div>';

  const stopDisabled = !isRunning;
  const statusClass = node.status || 'pending';
  const savedExecMode = localStorage.getItem('wf_execMode') || 'single';
  const execMode = savedExecMode === 'cascade' ? 'dependencies' : savedExecMode;
  const locked = node.locked;
  const mainProtected = isMainNode(wf, node);
  const dis = locked ? ' disabled' : '';
  let inputSourceHtml = '';
  if (mainProtected) {
    node.inputType = 'manual';
    node.inheritFrom = null;
    inputSourceHtml =
      '<div class="form-group" id="inputSourceGroup">' +
        '<label class="form-label">输入内容</label>' +
        '<textarea class="form-textarea" id="inpManualInput" rows="2" placeholder="输入内容将前置到 prompt"' + dis + '>' + esc(node.manualInput) + '</textarea>' +
      '</div>';
  } else {
    inputSourceHtml =
      '<div class="form-group">' +
        '<label class="form-label">输入来源</label>' +
        '<select class="form-select" id="selInputType"' + dis + '>' +
          '<option value="manual"' + (node.inputType === 'manual' ? ' selected' : '') + '>手动输入</option>' +
          '<option value="inherit"' + (node.inputType === 'inherit' ? ' selected' : '') + '>继承上级</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group" id="inputSourceGroup"' + (node.inputType === 'manual' ? '' : ' hidden') + '>' +
        '<label class="form-label">手动输入</label>' +
        '<textarea class="form-textarea" id="inpManualInput" rows="2" placeholder="输入内容将前置到 prompt"' + dis + '>' + esc(node.manualInput) + '</textarea>' +
      '</div>' +
      '<div class="form-group" id="inheritGroup"' + (node.inputType === 'inherit' ? '' : ' hidden') + '>' +
        '<label class="form-label">继承自</label>' +
        '<select class="form-select" id="selInheritFrom"' + dis + '>' + inheritOpts + '</select>' +
      '</div>';
  }

  content.innerHTML =
    '<section class="editor-card editor-primary-card">' +
      (locked ? '<div class="editor-card-notice"><span class="status-badge">🔒 已锁定，内容只读</span></div>' : '') +
      '<div class="form-group">' +
        '<label class="form-label">标题</label>' +
        '<input class="form-input" id="inpTitle" value="' + esc(node.title) + '"' + dis + '>' +
      '</div>' +
      inputSourceHtml +
      '<div class="form-group form-group-last">' +
        '<label class="form-label">Prompt</label>' +
        '<textarea class="form-textarea mono prompt-input" id="inpPrompt" rows="4"' + dis + '>' + esc(node.prompt) + '</textarea>' +
      '</div>' +
    '</section>' +
    '<section class="editor-card editor-options-card">' +
      '<div class="editor-section-title">生成参数与分类</div>' +
      '<div class="parameter-grid">' +
        '<div class="form-group form-group-last parameter-field">' +
          '<label class="form-label">Max Tokens</label>' +
          '<input class="form-input number" id="inpMaxTokens" type="number" value="' + node.maxTokens + '" min="1" max="32000"' + dis + '>' +
        '</div>' +
        '<div class="form-group form-group-last parameter-field">' +
          '<label class="form-label">Temperature</label>' +
          '<input class="form-input number" id="inpTemperature" type="number" value="' + node.temperature + '" min="0" max="2" step="0.1"' + dis + '>' +
        '</div>' +
        '<div class="form-group form-group-last color-field">' +
          '<label class="form-label">颜色标签</label>' +
          colorHtml +
        '</div>' +
      '</div>' +
    '</section>' +
    '<section class="execution-panel">' +
      '<div class="execution-toolbar">' +
        '<div class="execution-mode-group">' +
          '<label class="form-label" for="execMode">执行模式</label>' +
          '<select class="form-select execution-mode-select" id="execMode"' + dis + '>' +
            '<option value="single"' + (execMode==='single'?' selected':'') + '>仅当前节点</option>' +
            '<option value="dependencies"' + (execMode==='dependencies'?' selected':'') + '>依赖链（上级→当前）</option>' +
          '</select>' +
        '</div>' +
        '<div class="execution-meta">' +
          '<span class="status-badge ' + statusClass + '" id="statusBadge">' + getStatusText(node.status) + '</span>' +
          '<button class="btn btn-sm btn-outline lock-button" onclick="toggleNodeLock(\''+node.id+'\')"' + (mainProtected ? ' title="主节点不可删除；锁定仅用于防止误修改"' : '') + '>' + (locked ? '🔒 已锁定' : '🔓 锁定') + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="execution-actions">' +
        '<button class="btn btn-primary btn-sm" id="btnExecute">▶ 执行当前模式</button>' +
        '<button class="btn btn-sm" id="btnExecuteAll">▶ 运行整个流程树</button>' +
        '<button class="btn btn-sm btn-stop" id="btnStop"' + (stopDisabled ? ' disabled' : '') + '>⏹ 停止</button>' +
      '</div>' +
    '</section>' +
    '<div class="exec-progress" id="execProgress" hidden>' +
      '<div class="exec-progress-text" id="execProgressText">准备中...</div>' +
      '<div class="exec-progress-track"><div class="exec-progress-bar" id="execProgressBar"></div></div>' +
    '</div>' +
    '<div class="error-msg' + (node.error ? ' show' : '') + '" id="errorMsg">' + esc(node.error || '') + '</div>' +
    '<section class="editor-card output-area">' +
      '<div class="editor-section-title">输出</div>' +
      '<textarea class="form-textarea mono output-textarea" id="nodeOutput" readonly rows="6">' + esc(node.output || '') + '</textarea>' +
    '</section>';

  document.getElementById('inpTitle').addEventListener('change', function() {
    node.title = this.value;
    titleEl.textContent = this.value || '(未命名)';
    saveState();
    renderTree();
  });
  var inputTypeSelect = document.getElementById('selInputType');
  if (inputTypeSelect) inputTypeSelect.addEventListener('change', function() {
    node.inputType = this.value;
    markNodeExecutionStale(node);
    const manualGroup = document.getElementById('inputSourceGroup');
    const inheritGroup = document.getElementById('inheritGroup');
    if (manualGroup) manualGroup.hidden = this.value !== 'manual';
    if (inheritGroup) inheritGroup.hidden = this.value !== 'inherit';
    saveState();
    renderTree();
  });
  var manualInput = document.getElementById('inpManualInput');
  if (manualInput) {
    manualInput.addEventListener('input', function() {
      node.manualInput = this.value;
      markNodeExecutionStale(node);
      renderTree();
    });
    manualInput.addEventListener('change', function() {
      node.manualInput = this.value;
      saveState();
    });
  }
  var inheritSelect = document.getElementById('selInheritFrom');
  if (inheritSelect) inheritSelect.addEventListener('change', function() {
    node.inheritFrom = this.value || null;
    markNodeExecutionStale(node);
    saveState();
    renderTree();
  });
  var promptInput = document.getElementById('inpPrompt');
  promptInput.addEventListener('input', function() {
    node.prompt = this.value;
    markNodeExecutionStale(node);
    renderTree();
  });
  promptInput.addEventListener('change', function() {
    node.prompt = this.value;
    saveState();
  });
  document.getElementById('inpMaxTokens').addEventListener('change', function() {
    node.maxTokens = parseInt(this.value) || 4000;
    markNodeExecutionStale(node);
    saveState();
    renderTree();
  });
  document.getElementById('inpTemperature').addEventListener('change', function() {
    node.temperature = parseFloat(this.value) || 0.3;
    markNodeExecutionStale(node);
    saveState();
    renderTree();
  });
  document.querySelectorAll('.color-btn').forEach(function(el) {
    el.addEventListener('click', function() {
      node.color = this.dataset.color;
      document.querySelectorAll('.color-btn').forEach(function(b) { b.classList.remove('active'); });
      this.classList.add('active');
      saveState();
      renderTree();
    });
  });
  document.getElementById('execMode').addEventListener('change', function() {
    localStorage.setItem('wf_execMode', this.value);
  });
  document.getElementById('btnExecute').addEventListener('click', function() {
    saveCurrentNodeEdit();
    if (!selectedNodeId) return;
    if (document.getElementById('execMode').value === 'dependencies') {
      runDependencyChain(selectedNodeId);
    } else {
      executeNode(selectedNodeId);
    }
  });
  document.getElementById('btnExecuteAll').addEventListener('click', function() {
    saveCurrentNodeEdit();
    executeAll();
  });
  document.getElementById('btnStop').addEventListener('click', function() { stopExecution(); });
}

function getStatusText(status) {
  const m = { pending: '⏳ 待执行', running: '🔄 执行中', done: '✅ 完成', stale: '⚠️ 结果已过期', error: '❌ 错误', blocked: '🚫 依赖阻塞', stopped: '⏹ 已停止' };
  return m[status] || '⏳ 待执行';
}

function saveCurrentNodeEdit() {
  var wf = getActiveWorkflow();
  const node = wf && selectedNodeId ? findNode(wf.tree, selectedNodeId) : null;
  if (!node) return;
  const inp = document.getElementById('inpTitle');
  if (inp) node.title = inp.value;
  const sel = document.getElementById('selInputType');
  if (sel) node.inputType = sel.value;
  const mi = document.getElementById('inpManualInput');
  if (mi) node.manualInput = mi.value;
  const si = document.getElementById('selInheritFrom');
  if (si) node.inheritFrom = si.value || null;
  const pr = document.getElementById('inpPrompt');
  if (pr) node.prompt = pr.value;
  const mt = document.getElementById('inpMaxTokens');
  if (mt) node.maxTokens = parseInt(mt.value) || 4000;
  const tp = document.getElementById('inpTemperature');
  if (tp) node.temperature = parseFloat(tp.value) || 0.3;
  saveState();
}

function renderTree() {
  try{
  const container = document.getElementById('treeContainer');
  var wf = getActiveWorkflow();
  if (!container) { console.error('treeContainer not found!'); return; }
  if (!wf) { container.innerHTML = '<div class="tree-placeholder">暂无数据</div>'; return; }
  var topNode = ensureMainNode(wf);
  // Render only the protected main node as root of the visible tree, skipping the invisible 流程根节点
  if(topNode){
    container.innerHTML = '<div class="tree"><ul>' + renderNode(topNode, 0) + '</ul></div>';
  } else {
    container.innerHTML = '<div class="tree-placeholder">加载中...</div>';
  }
  }catch(e){console.error('renderTree error:',e);var c=document.getElementById('treeContainer');if(c)c.innerHTML='<div class="tree-error">⚠️ 渲染异常: '+esc(e.message)+'</div>';}
}

function renderNode(node, depth) {
  var wf = getActiveWorkflow();
  let path = wf ? getNodePath(wf.tree, node.id) : '';
  let sel = node.id === selectedNodeId ? ' selected' : '';
  let col = node.color ? ' color-' + node.color : '';
  let lok = node.locked ? ' locked' : '';
  let stat = node.status || 'pending';
  let validation = wf ? getNodeConfigurationIssue(wf, node) : null;
  let stateClass = stat === 'error' || stat === 'blocked' || (validation && validation.level === 'error') ? ' state-red' :
                   validation && validation.level === 'warning' ? ' state-blue' :
                   stat === 'running' || stat === 'stale' || stat === 'stopped' ? ' state-yellow' :
                   stat === 'done' && hasNodeText(node.output) ? ' state-green' : ' state-gray';
  let validationTitle = stat === 'blocked' || stat === 'error' ? (node.error || getStatusText(stat)) :
                        validation ? validation.reason :
                        stat === 'stale' ? '内容已修改，原执行结果已过期' :
                        stat === 'done' ? '执行完成，输出有效且可以复用' :
                        stat === 'running' ? '正在执行' : '等待执行';
  let html = '<li>';
  html += '<div class="t-node' + sel + col + lok + stateClass + '" data-id="' + node.id + '" title="' + escAttr(validationTitle) + '">';
  if (node.color) {
    var nodeColorLabels = { red:'红', orange:'橙', yellow:'黄', green:'绿', teal:'青绿', cyan:'青', blue:'蓝', indigo:'靛蓝', purple:'紫', pink:'粉', gray:'灰' };
    html += '<span class="node-color-tag" title="分类色：' + (nodeColorLabels[node.color] || node.color) + '"></span>';
  }
  var movable = !isMainNode(wf, node) && !node.locked;
  html += '<span class="node-drag" draggable="' + (movable ? 'true' : 'false') + '" data-id="' + node.id + '" title="' + (movable ? '拖拽移动节点' : '此节点不可移动') + '">⠿</span>';
  html += '<span class="node-num">' + (path ? path + '级' : '') + '</span>';
  html += '<span class="node-title">' + esc(node.title || '新节点') + '</span>';
  if(node.locked) html += '<span class="node-lock-indicator" title="节点已锁定">🔒</span>';
  html += '</div>';
  if (node.children && node.children.length > 0) {
    html += '<ul>';
    node.children.forEach(function(c) { html += renderNode(c, depth + 1); });
    html += '</ul>';
  }
  html += '</li>';
  return html;
}

// ── Tree event delegation ──
function closestTreeTarget(target, selector) {
  if (target && typeof target.closest === 'function') return target.closest(selector);
  if (target && target.parentElement && typeof target.parentElement.closest === 'function') {
    return target.parentElement.closest(selector);
  }
  return null;
}

document.getElementById('treeContainer').addEventListener('click', function(e) {
  var card = closestTreeTarget(e.target, '.t-node');
  if (!card) return;
  if (closestTreeTarget(e.target, '.node-drag')) return;
  selectedNodeId = card.dataset.id;
  renderAll();
});

document.getElementById('treeContainer').addEventListener('contextmenu', function(e) {
  var card = closestTreeTarget(e.target, '.t-node');
  if (!card) return;
  showContextMenu(e, card.dataset.id);
});

function clearTreeDropIndicators() {
  document.querySelectorAll('#treeContainer .t-node.drop-before,#treeContainer .t-node.drop-after,#treeContainer .t-node.drop-child').forEach(function(card) {
    card.classList.remove('drop-before', 'drop-after', 'drop-child');
  });
}

function getTreeDropMode(card, clientY) {
  var rect = card.getBoundingClientRect();
  var ratio = rect.height ? (clientY - rect.top) / rect.height : 0.5;
  if (ratio < 0.28) return 'before';
  if (ratio > 0.72) return 'after';
  return 'child';
}

document.getElementById('treeContainer').addEventListener('dragstart', function(e) {
  var handle = closestTreeTarget(e.target, '.node-drag');
  if (!handle || handle.getAttribute('draggable') !== 'true') {
    e.preventDefault();
    return;
  }
  draggedNodeId = handle.dataset.id;
  var card = handle.closest('.t-node');
  if (card) card.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedNodeId);
  }
});

document.getElementById('treeContainer').addEventListener('dragover', function(e) {
  var card = closestTreeTarget(e.target, '.t-node');
  if (!card || !draggedNodeId || card.dataset.id === draggedNodeId) return;
  var wf = getActiveWorkflow();
  var draggedNode = wf ? findNode(wf.tree, draggedNodeId) : null;
  if (!draggedNode || findNode(draggedNode, card.dataset.id)) return;
  var mode = getTreeDropMode(card, e.clientY);
  if ((mode === 'before' || mode === 'after') && wf && isMainNode(wf, card.dataset.id)) return;
  e.preventDefault();
  clearTreeDropIndicators();
  card.classList.add('drop-' + mode);
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
});

document.getElementById('treeContainer').addEventListener('drop', function(e) {
  var card = closestTreeTarget(e.target, '.t-node');
  if (!card || !draggedNodeId) return;
  e.preventDefault();
  var targetId = card.dataset.id;
  var mode = getTreeDropMode(card, e.clientY);
  var moved = mode === 'before' ? moveNodeBefore(draggedNodeId, targetId) :
              mode === 'after' ? moveNodeAfter(draggedNodeId, targetId) :
              moveNodeAsChild(draggedNodeId, targetId);
  draggedNodeId = null;
  clearTreeDropIndicators();
  if (moved) showToast('节点已移动', 'success');
});

document.getElementById('treeContainer').addEventListener('dragend', function() {
  draggedNodeId = null;
  document.querySelectorAll('#treeContainer .t-node.dragging').forEach(function(card) {
    card.classList.remove('dragging');
  });
  clearTreeDropIndicators();
});

// ── Workflow list functions ──
function renderWorkflowList(){
  var container = document.getElementById('wfListContainer');
  if(!container) return;
  var html = '';
  workflows.forEach(function(wf){
    var active = wf.id === activeWorkflowId ? ' active' : '';
    html += '<div class="wf-item' + active + '" data-id="' + wf.id + '">';
    html += '<span>📄</span>';
    html += '<span class="wf-item-title">' + esc(wf.title) + '</span>';
    html += '<span class="wf-item-date">' + (wf.updatedAt ? wf.updatedAt.slice(0,10) : '') + '</span>';
    html += '<span class="wf-del" data-id="' + wf.id + '">✕</span>';
    html += '</div>';
  });
  container.innerHTML = html;
}

function switchWorkflow(id){
  saveState();
  activeWorkflowId = id;
  selectedNodeId = null;
  var wf = getActiveWorkflow();
  if(wf){
    var mainNode = ensureMainNode(wf);
    if(!selectedNodeId||!findNode(wf.tree,selectedNodeId)){
      selectedNodeId=mainNode?mainNode.id:null;
    }
  }
  saveState();
  renderWorkflowList();
  renderAll();
  updateWfNameInput();
}

function deleteWorkflow(id){
  showConfirm('确定删除此流程吗？', function(){
    workflows = workflows.filter(w => w.id !== id);
    if(workflows.length === 0){
      newWorkflow();
      return;
    }
    if(activeWorkflowId === id) activeWorkflowId = workflows[0].id;
    saveState();
    renderWorkflowList();
    switchWorkflow(activeWorkflowId);
  });
}

function newWorkflow(){
  var wf = {
    id: 'wf_' + Date.now(),
    title: '新流程 ' + (workflows.length + 1),
    tree: createNode('流程根节点'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  var mainNode=createNode('主任务');mainNode.locked=false;mainNode._isMainNode=true;mainNode._parentId=wf.tree.id;
  wf.tree.children.push(mainNode);
  workflows.push(wf);
  activeWorkflowId = wf.id;
  selectedNodeId = wf.tree.children[0].id;
  saveState();
  renderWorkflowList();
  renderAll();
  updateWfNameInput();
}

function updateWfNameInput(){
  var inp = document.getElementById('wfNameInput');
  var wf = getActiveWorkflow();
  if(inp && wf && inp !== document.activeElement) inp.value = wf.title;
}

// ── Workflow version history ──
function cloneEditableNodeForVersion(node) {
  var snapshot = {};
  Object.keys(node || {}).forEach(function(key) {
    if (key === 'children' || key === 'output' || key === 'status' || key === 'error' ||
        key === '_parentId' || key === '_collapsed') return;
    var value = node[key];
    if (typeof value === 'undefined' || typeof value === 'function') return;
    snapshot[key] = value && typeof value === 'object'
      ? JSON.parse(JSON.stringify(value))
      : value;
  });
  snapshot.children = (node && Array.isArray(node.children) ? node.children : []).map(function(child) {
    return cloneEditableNodeForVersion(child);
  });
  return snapshot;
}

function createWorkflowVersionEntry(wf) {
  return {
    savedAt: new Date().toISOString(),
    title: wf && typeof wf.title === 'string' ? wf.title : '未命名流程',
    tree: cloneEditableNodeForVersion(wf ? wf.tree : null)
  };
}

function getWorkflowVersionFingerprint(entry) {
  return JSON.stringify({ title: entry ? entry.title : '', tree: entry ? entry.tree : null });
}

function collectVersionNodes(node, parentId, map) {
  if (!node) return;
  map[node.id] = { node: node, parentId: parentId };
  (node.children || []).forEach(function(child) {
    collectVersionNodes(child, node.id, map);
  });
}

function getExecutionRelevantFingerprint(node) {
  var data = {};
  Object.keys(node || {}).forEach(function(key) {
    if (key === 'children' || key === 'id' || key === 'title' || key === 'color' ||
        key === 'locked' || key === '_isMainNode') return;
    data[key] = node[key];
  });
  return JSON.stringify(data);
}

function markNodeExecutionStale(node) {
  if (!node) return;
  if (node.status !== 'pending' || hasNodeText(node.output)) node.status = 'stale';
  node.error = '';
  (node.children || []).forEach(function(child) {
    markNodeExecutionStale(child);
  });
}

function markChangedExecutionNodesStale(wf, previousEntry, currentEntry) {
  if (!wf || !previousEntry || !previousEntry.tree || !currentEntry || !currentEntry.tree) return;
  var previousMap = {};
  var currentMap = {};
  collectVersionNodes(previousEntry.tree, null, previousMap);
  collectVersionNodes(currentEntry.tree, null, currentMap);
  Object.keys(currentMap).forEach(function(nodeId) {
    var previous = previousMap[nodeId];
    var current = currentMap[nodeId];
    if (!previous) return;
    if (previous.parentId !== current.parentId ||
        getExecutionRelevantFingerprint(previous.node) !== getExecutionRelevantFingerprint(current.node)) {
      markNodeExecutionStale(findNode(wf.tree, nodeId));
    }
  });
}

function markAllWorkflowOutputsStale() {
  workflows.forEach(function(wf) {
    var mainNode = ensureMainNode(wf);
    if (mainNode) markNodeExecutionStale(mainNode);
  });
}

function normalizeHistoryMap(rawMap) {
  var result = {};
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return result;
  Object.keys(rawMap).forEach(function(workflowId) {
    if (!Array.isArray(rawMap[workflowId])) return;
    result[workflowId] = rawMap[workflowId].filter(function(entry) {
      return entry && typeof entry === 'object' && entry.tree && typeof entry.tree === 'object';
    }).slice(-MAX_WORKFLOW_HISTORY);
  });
  return result;
}

function loadWorkflowVersionHistory() {
  var raw = localStorage.getItem(WORKFLOW_HISTORY_KEY);
  var parsed = parseStoredJson(raw, null, '流程版本历史', 'wf_history_corrupt_backup');
  if (parsed && parsed.past && typeof parsed.past === 'object') {
    workflowVersionHistory = normalizeHistoryMap(parsed.past);
    workflowVersionFuture = normalizeHistoryMap(parsed.future);
    return;
  }
  var legacy = parseStoredJson(
    localStorage.getItem(LEGACY_WORKFLOW_HISTORY_KEY),
    {},
    '旧版流程历史'
  );
  workflowVersionHistory = normalizeHistoryMap(legacy);
  workflowVersionFuture = {};
}

function saveWorkflowVersionHistory() {
  localStorage.setItem(WORKFLOW_HISTORY_KEY, JSON.stringify({
    past: workflowVersionHistory,
    future: workflowVersionFuture
  }));
}

function initializeWorkflowVersionBaselines() {
  workflowVersionBaselines = {};
  workflows.forEach(function(wf) {
    var entry = createWorkflowVersionEntry(wf);
    workflowVersionBaselines[wf.id] = {
      fingerprint: getWorkflowVersionFingerprint(entry),
      entry: entry
    };
  });
  versionHistoryInitialized = true;
}

function trackWorkflowVersionChanges() {
  if (!versionHistoryInitialized) {
    initializeWorkflowVersionBaselines();
    return;
  }
  var currentIds = {};
  var historyChanged = false;
  workflows.forEach(function(wf) {
    currentIds[wf.id] = true;
    var entry = createWorkflowVersionEntry(wf);
    var fingerprint = getWorkflowVersionFingerprint(entry);
    var baseline = workflowVersionBaselines[wf.id];
    if (!baseline || isRestoringWorkflowVersion) {
      workflowVersionBaselines[wf.id] = { fingerprint: fingerprint, entry: entry };
      return;
    }
    if (baseline.fingerprint !== fingerprint) {
      markChangedExecutionNodesStale(wf, baseline.entry, entry);
      var history = workflowVersionHistory[wf.id] || [];
      history.push(baseline.entry);
      workflowVersionHistory[wf.id] = history.slice(-MAX_WORKFLOW_HISTORY);
      workflowVersionFuture[wf.id] = [];
      workflowVersionBaselines[wf.id] = { fingerprint: fingerprint, entry: entry };
      historyChanged = true;
    }
  });
  Object.keys(workflowVersionBaselines).forEach(function(workflowId) {
    if (!currentIds[workflowId]) delete workflowVersionBaselines[workflowId];
  });
  [workflowVersionHistory, workflowVersionFuture].forEach(function(historyMap) {
    Object.keys(historyMap).forEach(function(workflowId) {
      if (!currentIds[workflowId]) {
        delete historyMap[workflowId];
        historyChanged = true;
      }
    });
  });
  if (historyChanged) saveWorkflowVersionHistory();
}

function updateVersionControls() {
  var undoButton = document.getElementById('btnUndoVersion');
  var redoButton = document.getElementById('btnRedoVersion');
  var undoCount = document.getElementById('undoVersionCount');
  var redoCount = document.getElementById('redoVersionCount');
  if (!undoButton || !redoButton || !undoCount || !redoCount) return;
  var past = activeWorkflowId && workflowVersionHistory[activeWorkflowId]
    ? workflowVersionHistory[activeWorkflowId] : [];
  var future = activeWorkflowId && workflowVersionFuture[activeWorkflowId]
    ? workflowVersionFuture[activeWorkflowId] : [];
  undoCount.textContent = Math.min(past.length, MAX_WORKFLOW_HISTORY);
  redoCount.textContent = Math.min(future.length, MAX_WORKFLOW_HISTORY);
  undoButton.disabled = isRunning || past.length === 0;
  redoButton.disabled = isRunning || future.length === 0;
  undoButton.title = isRunning ? '流程执行期间不能撤销' :
    past.length ? '撤销到上一个流程版本' : '没有可撤销的版本';
  redoButton.title = isRunning ? '流程执行期间不能重做' :
    future.length ? '重做刚才撤销的流程版本' : '没有可重做的版本';
}

function applyWorkflowVersionEntry(wf, target) {
  var previousSelectedId = selectedNodeId;
  wf.title = typeof target.title === 'string' ? target.title : wf.title;
  wf.tree = normalizeNodeData(
    JSON.parse(JSON.stringify(target.tree)),
    null,
    new Set(),
    { count: 0 }
  );
  ensureMainNode(wf);
  repairInternalRootReferences(wf);
  wf.updatedAt = new Date().toISOString();
  selectedNodeId = previousSelectedId && findNode(wf.tree, previousSelectedId)
    ? previousSelectedId
    : ensureMainNode(wf).id;
}

function moveWorkflowVersion(direction) {
  if (isRunning) {
    showToast('流程执行期间不能切换版本', 'warning');
    return;
  }
  var wf = getActiveWorkflow();
  if (!wf) return;
  var source = direction === 'undo'
    ? (workflowVersionHistory[wf.id] || [])
    : (workflowVersionFuture[wf.id] || []);
  if (!source.length) {
    showToast(direction === 'undo' ? '没有可撤销的版本' : '没有可重做的版本', 'info');
    return;
  }
  var target = source[source.length - 1];
  var actionText = direction === 'undo' ? '撤销上一次修改' : '重做刚才的修改';
  showConfirm(actionText + '吗？流程内容会切换，执行结果将重置。', function() {
    var current = createWorkflowVersionEntry(wf);
    source.pop();
    if (direction === 'undo') {
      var future = workflowVersionFuture[wf.id] || [];
      future.push(current);
      workflowVersionFuture[wf.id] = future.slice(-MAX_WORKFLOW_HISTORY);
      workflowVersionHistory[wf.id] = source;
    } else {
      var past = workflowVersionHistory[wf.id] || [];
      past.push(current);
      workflowVersionHistory[wf.id] = past.slice(-MAX_WORKFLOW_HISTORY);
      workflowVersionFuture[wf.id] = source;
    }
    isRestoringWorkflowVersion = true;
    try {
      applyWorkflowVersionEntry(wf, target);
      var restoredEntry = createWorkflowVersionEntry(wf);
      workflowVersionBaselines[wf.id] = {
        fingerprint: getWorkflowVersionFingerprint(restoredEntry),
        entry: restoredEntry
      };
      saveWorkflowVersionHistory();
      saveState();
    } finally {
      isRestoringWorkflowVersion = false;
    }
    renderWorkflowList();
    renderAll();
    updateWfNameInput();
    showToast(direction === 'undo' ? '已撤销上一次修改' : '已重做修改', 'success');
  });
}

function undoWorkflowVersion() { moveWorkflowVersion('undo'); }
function redoWorkflowVersion() { moveWorkflowVersion('redo'); }

// ── Persistence ──
function saveState() {
  try {
    workflows = normalizeWorkflowList(workflows);
    if (activeWorkflowId && !workflows.some(function(wf) { return wf.id === activeWorkflowId; })) {
      activeWorkflowId = workflows.length ? workflows[0].id : null;
    }
    trackWorkflowVersionChanges();
    var activeWf = getActiveWorkflow();
    if (activeWf && (!selectedNodeId || selectedNodeId === activeWf.tree.id || !findNode(activeWf.tree, selectedNodeId))) {
      var fallbackMain = ensureMainNode(activeWf);
      selectedNodeId = fallbackMain ? fallbackMain.id : null;
    }
    localStorage.setItem('wf_list', JSON.stringify(workflows));
    localStorage.setItem('wf_active', activeWorkflowId || '');
    normalizeDeepSeekProviderState();
    localStorage.setItem('wf_provider', JSON.stringify({
      provider: providerState.provider,
      model: providerState.model
    }));
    if (selectedNodeId) localStorage.setItem('wf_selected', selectedNodeId);
    else localStorage.removeItem('wf_selected');
    updateVersionControls();
    return true;
  } catch(e) {
    console.error('保存流程失败:', e);
    if (document.getElementById('toastContainer')) showToast('保存失败: ' + e.message, 'error');
    return false;
  }
}

function loadState() {
  try {
    loadWorkflowVersionHistory();
    const list = localStorage.getItem('wf_list');
    workflows = normalizeWorkflowList(parseStoredJson(list, [], '流程数据', 'wf_list_corrupt_backup'));

    if (workflows.length === 0) {
      var wf = {
        id: 'wf_' + Date.now(),
        title: '未命名流程',
        tree: createNode('流程根节点'),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      var mn3=createNode('主任务');mn3.locked=false;mn3._isMainNode=true;mn3._parentId=wf.tree.id;wf.tree.children.push(mn3);
      workflows.push(normalizeWorkflowData(wf, 0));
    }

    activeWorkflowId = localStorage.getItem('wf_active') || workflows[0].id;
    if (!workflows.some(function(wf) { return wf.id === activeWorkflowId; })) {
      activeWorkflowId = workflows[0].id;
    }

    const prov = parseStoredJson(localStorage.getItem('wf_provider'), null, 'Provider 设置');
    if (prov && typeof prov === 'object' && !Array.isArray(prov)) {
      if (typeof prov.provider === 'string' && prov.provider) providerState.provider = prov.provider;
      if (typeof prov.model === 'string') providerState.model = prov.model;
      if (typeof prov.apiKey === 'string') providerState.apiKey = prov.apiKey;
    }

    const dp49 = localStorage.getItem('dp49');
    const dk30 = localStorage.getItem('dk30');
    if (dp49) {
      try { providerState.apiKey = atob(dp49); } catch(e) { providerState.apiKey = dk30 || providerState.apiKey || ''; }
    } else if (dk30) {
      providerState.apiKey = dk30;
    }
    normalizeDeepSeekProviderState();

    selectedNodeId = localStorage.getItem('wf_selected') || null;
    var activeWf = getActiveWorkflow();
    if (activeWf && (!selectedNodeId || selectedNodeId === activeWf.tree.id || !findNode(activeWf.tree, selectedNodeId))) {
      var loadedMainNode = ensureMainNode(activeWf);
      selectedNodeId = loadedMainNode ? loadedMainNode.id : null;
    }
    initializeWorkflowVersionBaselines();
    saveState();
  } catch(e) {
    console.error('加载流程失败:', e);
    var wf = {
      id: 'wf_' + Date.now(),
      title: '未命名流程',
      tree: createNode('流程根节点'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    var mn4=createNode('主任务');mn4.locked=false;mn4._isMainNode=true;mn4._parentId=wf.tree.id;wf.tree.children.push(mn4);
    workflows = [normalizeWorkflowData(wf, 0)];
    activeWorkflowId = wf.id;
    selectedNodeId = wf.tree.children[0].id;
    loadWorkflowVersionHistory();
    initializeWorkflowVersionBaselines();
    saveState();
  }
}

// ── Theme ──
document.getElementById('themeToggle').addEventListener('click', function(){
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  this.textContent = dark ? '🌙 暗色模式' : '☀️ 亮色模式';
  localStorage.setItem('wf_theme', dark ? 'light' : 'dark');
});

(function() {
  const saved = localStorage.getItem('wf_theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.getElementById('themeToggle').textContent = '☀️ 亮色模式';
  }
})();

// ── Collapse ──
function updateBtnPos(){
  const pl=document.getElementById('panelLeft'),pr=document.getElementById('panelRight');
  const bl=document.getElementById('collapseBtnLeft'),br=document.getElementById('collapseBtnRight');
  bl.style.left=(pl.classList.contains('collapsed')?0:pl.offsetWidth)+'px';
  br.style.right=(pr.classList.contains('collapsed')?0:pr.offsetWidth)+'px';
}
// ── Nav collapse ──
(function(){
  var h=document.getElementById('navHeader'),b=document.getElementById('navBody'),a=document.getElementById('navArrow');
  if(h)h.addEventListener('click',function(){var d=b.style.display==='none';b.style.display=d?'':'none';a.textContent=d?'▼':'▶';});
})();
// ── Workflow list collapse ──
(function(){
  var h=document.getElementById('wfListHeader'),b=document.getElementById('wfListBody'),a=document.getElementById('wfListArrow');
  if(h)h.addEventListener('click',function(){var d=b.style.display==='none';b.style.display=d?'':'none';a.textContent=d?'▼':'▶';});
})();
// ── Workflow name ──
document.getElementById('wfNameInput').addEventListener('input', function(){
  var wf = getActiveWorkflow();
  if(wf){wf.title = this.value; wf.updatedAt = new Date().toISOString(); renderWorkflowList();}
});
document.getElementById('wfNameInput').addEventListener('change', function(){
  var wf = getActiveWorkflow();
  if(wf){wf.title = this.value; wf.updatedAt = new Date().toISOString(); saveState(); renderWorkflowList();}
});

var _animFrame=null,_leftW=260,_rightW=380;
function animateBtnPos(){
  updateBtnPos();
  _animFrame=requestAnimationFrame(animateBtnPos);
}
function togglePanel(side){
  const pl=document.getElementById('panelLeft'),pr=document.getElementById('panelRight');
  const p=side==='left'?pl:pr;
  const isCollapsed=p.classList.contains('collapsed');
  if(isCollapsed){
    p.classList.remove('collapsed');
    p.style.width=(side==='left'?_leftW:_rightW)+'px';
    p.style.minWidth=(side==='left'?_leftW:_rightW)+'px';
  }else{
    if(side==='left')_leftW=p.offsetWidth;else _rightW=p.offsetWidth;
    p.style.width='0px';p.style.minWidth='0px';
    p.classList.add('collapsed');
  }
  if(_animFrame)cancelAnimationFrame(_animFrame);
  animateBtnPos();
  setTimeout(function(){cancelAnimationFrame(_animFrame);_animFrame=null;updateBtnPos();},360);
}
document.getElementById('collapseBtnLeft').addEventListener('click',function(){togglePanel('left')});
document.getElementById('collapseBtnRight').addEventListener('click',function(){togglePanel('right')});

// ── Resize ──
(function(){
  const rh=document.getElementById('resizeHandle'),pr=document.getElementById('panelRight');
  let d=false,sx=0,sw=0;
  rh.addEventListener('mousedown',function(e){d=true;sx=e.clientX;sw=pr.offsetWidth;pr.classList.add('dragging');e.preventDefault()});
  document.addEventListener('mousemove',function(e){
    if(!d)return;
    const w=Math.max(320,Math.min(720,sw+sx-e.clientX));
    pr.style.width=w+'px';pr.style.minWidth=w+'px';
    _rightW=w;localStorage.setItem('layout_right_w',w);
    updateBtnPos();
  });
  document.addEventListener('mouseup',function(){if(d){d=false;pr.classList.remove('dragging')}});
})();

// ── Tree buttons ──
// ── Event delegation for tree buttons and workflow list ──
document.getElementById('treeButtons').addEventListener('click', function(e) {
  var btn = e.target.closest('.btn[data-action]');
  if (!btn) return;
  e.stopPropagation();
  var action = btn.dataset.action;
  if (action === 'executeTree') {
    saveCurrentNodeEdit();
    executeAll();
  } else if (action === 'addChild') {
    var wfa = getActiveWorkflow();
    if (!wfa) { showToast('请先创建一个流程', 'warning'); return; }
    if (!selectedNodeId || !findNode(wfa.tree, selectedNodeId)) {
      if (wfa.tree.children.length > 0) {
        selectedNodeId = wfa.tree.children[0].id;
      } else {
        showToast('请先选择一个节点', 'warning'); return;
      }
    }
    var nid = addChild(selectedNodeId);
    if (nid) selectedNodeId = nid;
    renderAll();
    } else if (action === 'deleteCurrent') {
      if (!selectedNodeId) { showToast('请先选择一个节点', 'warning'); return; }
      deleteCurrentNode(selectedNodeId);
    } else if (action === 'deleteNode') {
      if (!selectedNodeId) { showToast('请先选择一个节点', 'warning'); return; }
      deleteNode(selectedNodeId);
  } else if (action === 'copyNode') {
    if (!selectedNodeId) { showToast('请先选择一个节点', 'warning'); return; }
    copyNode(selectedNodeId);
  } else if (action === 'pasteNode') {
    if (!selectedNodeId) { showToast('请先选择一个节点', 'warning'); return; }
    pasteNode(selectedNodeId);
  }
});
// ── Event delegation for workflow list ──
document.getElementById('wfListContainer').addEventListener('click', function(e) {
  var item = e.target.closest('.wf-item');
  if (!item) return;
  if (e.target.closest('.wf-del')) {
    deleteWorkflow(item.dataset.id);
    return;
  }
  switchWorkflow(item.dataset.id);
});

// ── Init ──
_leftW=Math.max(220,Math.min(340,parseInt(localStorage.getItem('layout_left_w'))||260));
_rightW=Math.max(320,Math.min(720,parseInt(localStorage.getItem('layout_right_w'))||380));
document.getElementById('panelLeft').style.width=_leftW+'px';document.getElementById('panelLeft').style.minWidth=_leftW+'px';
document.getElementById('panelRight').style.width=_rightW+'px';document.getElementById('panelRight').style.minWidth=_rightW+'px';

// Load persisted workflows before the first render. Never clear user data during startup.
loadState();
renderWorkflowList();
var btnWf=document.getElementById('btnNewWorkflow');
if(btnWf)btnWf.addEventListener('click',newWorkflow);
var btnUndoVersion=document.getElementById('btnUndoVersion');
var btnRedoVersion=document.getElementById('btnRedoVersion');
if(btnUndoVersion)btnUndoVersion.addEventListener('click',undoWorkflowVersion);
if(btnRedoVersion)btnRedoVersion.addEventListener('click',redoWorkflowVersion);
updateBtnPos();
try{renderAll();}catch(e){console.error('renderAll',e);}
window.addEventListener('resize',updateBtnPos);
window.addEventListener('beforeunload', function() {
  saveCurrentNodeEdit();
  saveState();
});

// Handle keyboard copy/paste
document.addEventListener('keydown', function(e) {
  var tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
    if (selectedNodeId) { copyNode(selectedNodeId); e.preventDefault(); }
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
    if (selectedNodeId) { pasteNode(selectedNodeId); e.preventDefault(); }
  }
});

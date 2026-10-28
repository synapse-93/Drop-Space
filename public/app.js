document.querySelectorAll('.workspace-tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.workspace-tab').forEach(item => item.classList.toggle('active', item === tab));
  document.querySelectorAll('.tab-panel').forEach(panel => { panel.hidden = panel.id !== tab.dataset.tab; });
}));
document.getElementById('open-link-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = document.getElementById('share-link-input');
  const message = document.getElementById('link-message');
  try {
    const target = new URL(input.value.trim());
    if (target.origin !== location.origin || !/^\/s\/[A-Za-z0-9_-]+\/?$/.test(target.pathname)) {
      throw new Error('Paste a valid Drop Space share link from this site.');
    }
    location.href = target.href;
  } catch (error) {
    message.textContent = error instanceof TypeError ? 'Enter a valid share URL.' : error.message;
    message.className = 'message error';
  }
});
const form = document.getElementById('upload-form');
const input = document.getElementById('file-input');
const fileLabel = document.getElementById('file-label');
const message = document.getElementById('upload-message');
const list = document.getElementById('file-list');
const quota = document.getElementById('quota');
const quotaFill = document.getElementById('quota-fill');
const search = document.getElementById('search');
const dropzone = document.getElementById('dropzone');
const progress = document.getElementById('upload-progress');
const expiry = document.getElementById('expiry');
const customExpiry = document.getElementById('custom-expiry');
let currentFiles = [];
const fmtBytes = bytes => bytes < 1024 * 1024 ? (bytes / 1024).toFixed(0) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB';

function updateSelectedFile() {
  const file = input.files[0];
  fileLabel.textContent = file ? file.name + ' · ' + fmtBytes(file.size) : 'Drop your file here or browse';
}
input.addEventListener('change', updateSelectedFile);
expiry.addEventListener('change', () => {
  const custom = expiry.value === 'custom';
  customExpiry.hidden = !custom;
  customExpiry.required = custom;
  if (custom) {
    const minimum = new Date(Date.now() + 5 * 60000);
    customExpiry.min = new Date(minimum.getTime() - minimum.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
});
for (const eventName of ['dragenter', 'dragover']) dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.add('dragging'); });
for (const eventName of ['dragleave', 'drop']) dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.remove('dragging'); });
dropzone.addEventListener('drop', event => {
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  updateSelectedFile();
});
search.addEventListener('input', renderFiles);

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.replace('/login');
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const file = input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { message.textContent = 'That file exceeds the 10 MB limit.'; message.className = 'message error'; return; }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Uploading…';
  message.textContent = 'Saving your file and creating its share link…';
  message.className = 'message';
  progress.hidden = false;
  progress.classList.add('is-active');
  try {
    const formData = new FormData(form);
    if (expiry.value === 'custom') {
      const selected = new Date(customExpiry.value);
      if (!customExpiry.value || Number.isNaN(selected.getTime()) || selected.getTime() < Date.now() + 60000) throw new Error('Choose an expiry at least one minute in the future.');
      formData.set('expiresAt', selected.toISOString());
    }
    const result = await uploadFile(formData);
    const link = new URL(result.file.shareUrl, location.origin).href;
    message.replaceChildren();
    const text = document.createElement('span');
    text.textContent = 'File saved. Share link: ';
    const anchor = document.createElement('a');
    anchor.href = link;
    anchor.textContent = link;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'text-button';
    copy.textContent = 'Copy link';
    copy.addEventListener('click', () => copyShareLink(link, copy));
    message.append(text, anchor, copy);
    message.className = 'message success';
    form.reset();
    customExpiry.hidden = true;
    updateSelectedFile();
    await loadFiles();
  } catch (error) {
    message.textContent = error.message;
    message.className = 'message error';
  } finally {
    button.disabled = false;
    button.textContent = 'Upload & create link';
    progress.hidden = true;
    progress.classList.remove('is-active');
    progress.value = 0;
  }
});

function uploadFile(formData) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/files');
    request.upload.addEventListener('progress', event => {
      if (event.lengthComputable) progress.value = Math.round(event.loaded / event.total * 100);
    });
    request.addEventListener('load', () => {
      let data;
      try { data = JSON.parse(request.responseText); } catch { reject(new Error('The server returned an unreadable response.')); return; }
      if (request.status === 401) { location.replace('/login'); reject(new Error('Your session expired. Sign in again.')); return; }
      if (request.status < 200 || request.status >= 300) reject(new Error(data.error || 'Upload failed.'));
      else resolve(data);
    });
    request.addEventListener('error', () => reject(new Error('Upload failed. Check the MongoDB connection and try again.')));
    request.send(formData);
  });
}

async function copyShareLink(link, button) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(link);
    } else {
      const field = document.createElement('textarea');
      field.className = 'clipboard-fallback';
      field.value = link;
      field.setAttribute('readonly', '');
      document.body.append(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      if (!copied) throw new Error('Clipboard unavailable');
    }
    const previous = button.textContent;
    button.textContent = 'Copied';
    window.setTimeout(() => { button.textContent = previous; }, 1500);
  } catch {
    window.prompt('Copy this share link:', link);
  }
}

async function loadFiles() {
  try {
    const response = await fetch('/api/owner');
    const data = await response.json();
    if (response.status === 401) { location.replace('/login'); return; }
    if (!response.ok) throw new Error(data.error || 'Could not load files.');
    quota.textContent = fmtBytes(data.usedBytes) + ' / ' + fmtBytes(data.quotaBytes) + ' · ' + Math.max(0, data.uploadLimit - data.uploadsThisHour) + ' uploads left this hour';
    quotaFill.value = Math.min(100, data.usedBytes / data.quotaBytes * 100);
    currentFiles = data.files;
    renderFiles();
  } catch (error) {
    list.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'empty-state error';
    empty.textContent = error.message;
    list.append(empty);
  }
}

function renderFiles() {
  const query = search.value.trim().toLocaleLowerCase();
  const filtered = currentFiles.filter(file => file.name.toLocaleLowerCase().includes(query));
  list.replaceChildren();
  if (!currentFiles.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-icon">↗</span><strong>No shares yet</strong><span>Upload your first file above and its link will show up here.</span></div>';
    return;
  }
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No files match your search.';
    list.append(empty);
    return;
  }
  for (const file of filtered) {
    const expired = Date.now() >= Date.parse(file.expiresAt);
    const row = document.createElement('article');
    row.className = 'file-row';
    const info = document.createElement('div');
    info.className = 'file-info';
    const name = document.createElement('strong');
    name.textContent = file.name;
    const meta = document.createElement('span');
    meta.textContent = fmtBytes(file.size) + ' · ' + file.downloads + ' download' + (file.downloads === 1 ? '' : 's') + ' · ' + (expired ? 'Expired' : 'Expires ' + new Date(file.expiresAt).toLocaleString());
    info.append(name, meta);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const state = document.createElement('span');
    state.className = 'status ' + (file.revoked || expired ? 'revoked' : 'active');
    state.textContent = file.revoked ? 'Revoked' : expired ? 'Expired' : 'Active';
    actions.append(state);
    const copy = document.createElement('button');
    copy.className = 'small-button';
    copy.textContent = 'Copy link';
    copy.disabled = file.revoked || expired;
    copy.addEventListener('click', () => copyShareLink(new URL(file.shareUrl, location.origin).href, copy));
    actions.append(copy);
    if (!file.revoked) {
      const revoke = document.createElement('button');
      revoke.className = 'small-button';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', () => changeFile(file.id, 'revoke'));
      actions.append(revoke);
    }
    const remove = document.createElement('button');
    remove.className = 'small-button danger';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => changeFile(file.id, 'delete'));
    actions.append(remove);
    row.append(info, actions);
    list.append(row);
  }
}

async function changeFile(id, action) {
  const prompt = action === 'delete' ? 'Delete this file and permanently remove its share link?' : 'Revoke this share link now?';
  if (!window.confirm(prompt)) return;
  const response = await fetch('/api/files/' + id + '/' + action, { method: 'POST' });
  const data = await response.json();
  if (response.status === 401) { location.replace('/login'); return; }
  if (!response.ok) { window.alert(data.error || 'Action failed.'); return; }
  await loadFiles();
}

loadFiles();

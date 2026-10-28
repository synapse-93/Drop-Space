(async () => {
  const token = location.pathname.split('/').filter(Boolean).pop();
  const title = document.getElementById('share-title');
  const detail = document.getElementById('share-detail');
  try {
    const response = await fetch('/api/share/' + encodeURIComponent(token));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'This link is unavailable.');
    title.textContent = data.name;
    detail.textContent = 'Ready to download · Expires ' + new Date(data.expiresAt).toLocaleString();
    const button = document.getElementById('download-button');
    button.href = data.downloadUrl;
    button.hidden = false;
  } catch (error) {
    title.textContent = 'Link unavailable';
    detail.textContent = error.message;
  }
})();

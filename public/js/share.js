(function () {
  var dataEl = document.getElementById('file-data');
  var fileData;
  try {
    fileData = JSON.parse(dataEl?.textContent || '{}');
  } catch {
    fileData = {};
  }

  if (fileData.needsPassword) {
    showPasswordGate();
    return;
  }

  if (fileData.error) {
    showError(fileData.error);
    return;
  }

  if (fileData.isFolder) {
    showFolder(fileData);
    return;
  }

  if (!fileData.name) {
    showError('此分享链接可能已过期或已被撤销。');
    return;
  }

  showFile(fileData);

  function showPasswordGate() {
    document.getElementById('password-gate').classList.remove('hidden');
    var form = document.getElementById('password-form');
    form.action = window.location.pathname + '/verify';
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var formData = new URLSearchParams(new FormData(form));
      try {
        var res = await fetch(form.action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData,
          credentials: 'same-origin',
          redirect: 'follow',
        });
        if (res.redirected) {
          window.location.href = res.url;
        } else if (res.ok) {
          window.location.reload();
        } else {
          var err = document.getElementById('password-error');
          err.textContent = '密码错误';
          err.classList.remove('hidden');
        }
      } catch {
        var err = document.getElementById('password-error');
        err.textContent = '连接错误';
        err.classList.remove('hidden');
      }
    });
  }

  function showError(msg) {
    document.getElementById('error-view').classList.remove('hidden');
    document.getElementById('error-message').textContent = msg;
  }

  function showFile(file) {
    document.getElementById('file-view').classList.remove('hidden');
    document.getElementById('file-name').textContent = file.name;
    document.getElementById('file-size').textContent = formatBytes(file.size);
    document.getElementById('file-date').textContent = formatDate(file.uploadedAt);
    document.getElementById('file-downloads').textContent = (file.downloads || 0) + ' 次下载';
    document.getElementById('file-icon').innerHTML = getFileIcon(file.type, file.name);
    var brandName = 'CloudVault';
    try { brandName = JSON.parse(document.getElementById('branding-data')?.textContent || '{}').siteName || brandName; } catch {}
    document.title = file.name + ' — ' + brandName;

    var token = window.location.pathname.split('/').pop();
    var downloadUrl = '/s/' + token + '/download';
    document.getElementById('download-btn').href = downloadUrl;

    setupCopyButton(token);
  }

  function showFolder(data) {
    document.getElementById('folder-view').classList.remove('hidden');
    var brandName = 'CloudVault';
    try { brandName = JSON.parse(document.getElementById('branding-data')?.textContent || '{}').siteName || brandName; } catch {}
    document.title = (data.folderName || '分享的文件夹') + ' — ' + brandName;

    var token = window.location.pathname.split('/').pop();
    var titleEl = document.getElementById('folder-title');
    var breadcrumbEl = document.getElementById('folder-breadcrumb');
    var subfoldersEl = document.getElementById('folder-subfolders');
    var filesEl = document.getElementById('folder-files');

    var currentDisplayName = data.subpath
      ? data.subpath.split('/').pop()
      : data.folderName;
    titleEl.textContent = currentDisplayName;

    breadcrumbEl.innerHTML = '';
    if (data.subpath) {
      var rootLink = document.createElement('a');
      rootLink.href = '/s/' + token;
      rootLink.textContent = data.folderName;
      rootLink.className = 'folder-tag';
      breadcrumbEl.appendChild(rootLink);

      var parts = data.subpath.split('/');
      for (var i = 0; i < parts.length; i++) {
        var sep = document.createElement('span');
        sep.textContent = '/';
        sep.className = 'text-xs';
        sep.style.color = 'var(--text-muted)';
        breadcrumbEl.appendChild(sep);

        if (i < parts.length - 1) {
          var partLink = document.createElement('a');
          partLink.href = '/s/' + token + '?path=' + encodeURIComponent(parts.slice(0, i + 1).join('/'));
          partLink.textContent = parts[i];
          partLink.className = 'folder-tag';
          breadcrumbEl.appendChild(partLink);
        } else {
          var partSpan = document.createElement('span');
          partSpan.textContent = parts[i];
          partSpan.className = 'folder-tag active';
          breadcrumbEl.appendChild(partSpan);
        }
      }
    }

    subfoldersEl.innerHTML = '';
    var subfolders = data.subfolders || [];
    for (var s = 0; s < subfolders.length; s++) {
      var sf = subfolders[s];
      var sfName = sf.split('/').pop();
      var relativePath = sf.slice(data.folder.length + 1);

      var sfDiv = document.createElement('a');
      sfDiv.href = '/s/' + token + '?path=' + encodeURIComponent(relativePath);
      sfDiv.className = 'share-row';
      sfDiv.innerHTML =
        '<span class="share-row-icon" aria-hidden="true">'
          + folderIcon()
        + '</span>'
        + '<span class="share-row-copy"><span class="share-row-title truncate">' + escHtml(sfName) + '</span><span class="share-row-subtitle">点击进入子目录</span></span>'
        + '<svg class="w-4 h-4 share-row-arrow ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>';
      subfoldersEl.appendChild(sfDiv);
    }

    filesEl.innerHTML = '';
    var files = data.files || [];
    for (var f = 0; f < files.length; f++) {
      var file = files[f];
      var fileDiv = document.createElement('div');
      fileDiv.className = 'share-row';

      var previewUrl = '/s/' + token + '/folder-preview?fileId=' + file.id;
      var isImage = file.type && file.type.startsWith('image/');
      var iconHtml = isImage
        ? '<span class="share-row-icon"><img src="' + previewUrl + '" class="object-cover" loading="lazy" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'inline-flex\'"><span class="share-row-icon hidden">' + getFileIcon(file.type, file.name) + '</span></span>'
        : '<span class="share-row-icon">' + getFileIcon(file.type, file.name) + '</span>';

      fileDiv.innerHTML = iconHtml +
        '<div class="share-row-copy"><span class="share-row-title truncate">' + escHtml(file.name) + '</span><span class="share-row-subtitle">' + formatBytes(file.size) + '</span></div>' +
        '<a href="/s/' + token + '/folder-download?fileId=' + file.id + '" class="dl-btn">' +
        '<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg><span>下载</span></a>';
      filesEl.appendChild(fileDiv);
    }

    var copyBtn = document.getElementById('folder-copy-btn');
    var toast = document.getElementById('copy-toast');
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(window.location.origin + '/s/' + token).then(function () {
        toast.classList.add('show');
        setTimeout(function () { toast.classList.remove('show'); }, 2000);
      });
    });
  }

  function isCodeFile(name) {
    return /\.(js|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|sh|bash|yaml|yml|toml|json|xml|sql|graphql|md|html|css|scss|less)$/i.test(name || '');
  }

  function setupCopyButton(token) {
    var btn = document.getElementById('copy-btn');
    var toast = document.getElementById('copy-toast');
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(window.location.origin + '/s/' + token).then(function () {
        toast.classList.add('show');
        setTimeout(function () { toast.classList.remove('show'); }, 2000);
      });
    });
  }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function getFileIcon(type, name) {
    var n = (name || '').toLowerCase();
    var icon = function(color, path) {
      return '<svg class="w-5 h-5" style="color:' + color + '" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7">' + path + '</svg>';
    };
    if (type && type.startsWith('image/')) return icon('#f472b6', '<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z"/>');
    if (type && type.startsWith('video/')) return icon('#a78bfa', '<path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15.91 11.672a.375.375 0 010 .656l-5.603 3.113a.375.375 0 01-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112z"/>');
    if (type && type.startsWith('audio/')) return icon('#34d399', '<path stroke-linecap="round" stroke-linejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z"/>');
    if (type === 'application/pdf') return icon('#ef4444', '<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>');
    if (type && (type.includes('zip') || type.includes('tar') || type.includes('rar') || type.includes('gzip') || type.includes('x-7z'))) return icon('#fbbf24', '<path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"/>');
    if (/\.(apk|aab)$/.test(n)) return icon('#34d399', '<path stroke-linecap="round" stroke-linejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3"/>');
    if (/\.(exe|msi|dmg|pkg|deb|rpm)$/.test(n)) return icon('#a78bfa', '<path stroke-linecap="round" stroke-linejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z"/>');
    if (type && (type.startsWith('text/') || isCodeFile(name))) return icon('#f97316', '<path stroke-linecap="round" stroke-linejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"/>');
    return icon('#94a3b8', '<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>');
  }

  function folderIcon() {
    return '<svg class="w-5 h-5 text-accent-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"/></svg>';
  }
})();

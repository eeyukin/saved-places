var q=function(s){return Array.from(document.querySelectorAll(s));};
var meta=q('meta[property^="og:"],meta[name="description"]').map(function(m){return m.outerHTML;}).join('\n');
var cap=q('h1').map(function(h){return h.innerText;}).join('\n').slice(0,3000);
var u=location.href.split('?')[0];
completion('https://eeyukin.github.io/saved-places/?url='+encodeURIComponent(u)+'&meta='+encodeURIComponent(meta)+'&text='+encodeURIComponent(cap));

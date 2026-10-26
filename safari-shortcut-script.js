var q=function(s){return Array.from(document.querySelectorAll(s));};
var meta=q('meta[property^="og:"],meta[name="description"]').map(function(m){return m.outerHTML;}).join('\n');
var cap=q('h1').map(function(h){return h.innerText;}).join('\n').slice(0,3000);
var u=location.href.split('?')[0];
var img=(document.querySelector('meta[property="og:image"]')||{}).content||'';
var sent=false;
function done(thumb){if(sent)return;sent=true;completion('https://eeyukin.github.io/saved-places/?url='+encodeURIComponent(u)+'&meta='+encodeURIComponent(meta)+'&text='+encodeURIComponent(cap)+(thumb?'&thumb='+encodeURIComponent(thumb):'&thumberr=1'));}
setTimeout(function(){done('');},5000);
if(!img){done('');}else{fetch(img).then(function(r){return r.blob();}).then(function(b){return createImageBitmap(b);}).then(function(bm){var s=Math.min(1,320/Math.max(bm.width,bm.height));var c=document.createElement('canvas');c.width=Math.round(bm.width*s);c.height=Math.round(bm.height*s);c.getContext('2d').drawImage(bm,0,0,c.width,c.height);done(c.toDataURL('image/jpeg',0.7));}).catch(function(){done('');});}

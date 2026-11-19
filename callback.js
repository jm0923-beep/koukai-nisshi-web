// Google sends the browser here after login with the result in the URL
// fragment (#access_token=… or #error=…). Hand it to the journal page and leave.
(function(){
  "use strict";
  var params = new URLSearchParams(location.hash.slice(1));
  // Google's file picker may put the picked ids in the query instead of the fragment.
  new URLSearchParams(location.search).forEach(function(v, k){ if(!params.has(k)){ params.set(k, v); } });
  // Remove the token from the address bar and history right away.
  history.replaceState(null, "", location.pathname);

  var result = {
    state: params.get("state"),
    access_token: params.get("access_token"),
    expires_in: params.get("expires_in"),
    error: params.get("error"),
    picked_file_ids: params.get("picked_file_ids")
  };

  // "Googleドライブから添付": the popup that showed Google's file picker.
  if(window.name === "nisshi_google_pick"){
    try{ localStorage.setItem("nisshi_web_pick", JSON.stringify(result)); } catch(e){}
    try{ if(window.opener && window.opener !== window){ window.opener.postMessage({ type: "nisshi-pick", result: result }, location.origin); } } catch(e){}
    document.getElementById("msg").textContent = "選んだファイルを日誌に取り込みます。この画面を閉じて、日誌に戻ってください。";
    window.close();
    return;
  }

  // Opened as a popup to reconnect while the journal is open.
  if(window.opener && window.opener !== window){
    try{
      window.opener.postMessage({ type: "nisshi-oauth", result: result }, location.origin);
      window.close();
      return;
    } catch(e){}
  }
  // A popup whose opener iOS dropped: the journal page listens for this key.
  if(window.name === "nisshi_google_login"){
    try{ localStorage.setItem("nisshi_web_popup", JSON.stringify(result)); } catch(e){}
    document.getElementById("msg").textContent = "接続しました。この画面を閉じて、日誌に戻ってください。";
    window.close();
    return;
  }
  // Full-page login from the gate.
  try{ sessionStorage.setItem("nisshi_web_redirect_result", JSON.stringify(result)); } catch(e){}
  location.replace(new URL("./", location.href).href);
})();

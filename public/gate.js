(function () {
  'use strict';

  window.requireAuth = async function () {
    try {
      var settingsRes = await fetch('/auth/settings', { cache: 'no-store' });
      var settings = await settingsRes.json();
      if (!settings.initialized) {
        window.location.replace('/init');
        return false;
      }
      var meRes = await fetch('/auth/me', { cache: 'no-store' });
      var me = await meRes.json();
      if (!me.user) {
        window.location.replace('/login');
        return false;
      }
      return true;
    } catch (e) {
      window.location.replace('/login');
      return false;
    }
  };
})();

// auth.js — sign-in (OTP) flow and session application.
//
// Loads after ui.js (uses showToast and various UI state resets inside
// applySession) and before app.js (app.js wires the sb.auth state handlers
// that call applySession).

// ---- Auth state ----
var userId = null;
var hydratedForUser = null;

// Two-step OTP flow instead of magic-link-only:
// 1. User types email, we call signInWithOtp to send a 6-digit code.
// 2. User types the code, we call verifyOtp to establish the session.
// The magic link itself still works as a fallback (we keep the redirectTo
// so clicking the link in Safari still works), but the primary flow stays
// entirely inside the PWA — critical for iOS home-screen installs where
// Safari-opened magic links can't reach the standalone app.

var authForm = document.getElementById('authForm');
var authEmail = document.getElementById('authEmail');
var authCode = document.getElementById('authCode');
var authSubmit = document.getElementById('authSubmit');
var authStatus = document.getElementById('authStatus');
var authDesc = document.getElementById('authDesc');
var authLinks = document.getElementById('authLinks');
var authResend = document.getElementById('authResend');
var authBack = document.getElementById('authBack');

var authStep = 'email';       // 'email' | 'code'
var authPendingEmail = '';    // the email we sent the code to

// ---- Helpers ----
function setAuthStatus(msg, kind) {
  authStatus.textContent = msg || '';
  authStatus.className = 'auth-status' + (kind ? ' ' + kind : '');
}

function setAuthStep(step) {
  authStep = step;
  if (step === 'email') {
    authDesc.textContent = "Enter your email and we'll send you a sign-in code.";
    authEmail.style.display = '';
    authCode.style.display = 'none';
    authCode.value = '';
    authSubmit.textContent = 'Send code';
    authLinks.style.display = 'none';
    setTimeout(function(){ authEmail.focus(); }, 50);
  } else {
    authDesc.textContent = 'Enter the code sent to ' + authPendingEmail + '.';
    authEmail.style.display = 'none';
    authCode.style.display = '';
    authSubmit.textContent = 'Verify';
    authLinks.style.display = 'flex';
    setTimeout(function(){ authCode.focus(); }, 50);
  }
}

async function sendLoginCode(email) {
  authSubmit.disabled = true;
  setAuthStatus('Sending code…');
  var res = await sb.auth.signInWithOtp({
    email: email,
    options: { emailRedirectTo: window.location.origin },
  });
  authSubmit.disabled = false;
  if (res.error) {
    setAuthStatus(res.error.message, 'err');
    return false;
  }
  return true;
}

// ---- Auth form listeners ----
authForm.addEventListener('submit', async function(e) {
  e.preventDefault();
  if (authStep === 'email') {
    var email = (authEmail.value || '').trim();
    if (!email) return;
    var ok = await sendLoginCode(email);
    if (!ok) return;
    authPendingEmail = email;
    setAuthStep('code');
    setAuthStatus('Code sent — check your email.', 'ok');
  } else {
    var code = (authCode.value || '').trim();
    if (!/^\d{4,10}$/.test(code)) {
      setAuthStatus('Enter the code from your email (digits only).', 'err');
      return;
    }
    authSubmit.disabled = true;
    setAuthStatus('Verifying…');
    var res = await sb.auth.verifyOtp({
      email: authPendingEmail,
      token: code,
      type: 'email',
    });
    authSubmit.disabled = false;
    if (res.error) {
      setAuthStatus(res.error.message, 'err');
      return;
    }
    // Session is now set; onAuthStateChange fires applySession → hydrate.
  }
});

authResend.addEventListener('click', async function() {
  if (!authPendingEmail) return;
  await sendLoginCode(authPendingEmail);
  setAuthStatus('New code sent.', 'ok');
});

authBack.addEventListener('click', function() {
  authPendingEmail = '';
  setAuthStep('email');
  setAuthStatus('');
});

// ---- Apply session ----
function applySession(session) {
  if (session && session.user) {
    document.body.classList.remove('unauthed');
    if (hydratedForUser === session.user.id) return;
    hydratedForUser = session.user.id;
    activePlanId = null; plan = null;
    todayState = null; todayPlanStates = {}; todayAdHocs = [];
    suggestedDayIndex = null;
    historicalCache = {}; planCache = {}; exerciseIdCache = {};
    exerciseLibrary = []; exerciseLibraryByName = {}; exerciseLibraryById = {};
    recentExercises = [];
    pickerState = { search: '', equipment: [], muscleGroup: [] };
    historyWeekCache = {}; historyDetails = {};
    historyWeekStart = null; historyWeekLoading = false; historyView = 'week';
    earliestWorkoutDate = null;
    photosGoal = null; photosProgress = []; photosLoaded = false;
    photosSignedUrls = {};
    currentDay = 0;
    hydrate();
  } else {
    hydratedForUser = null;
    stopTimerTick();
    sessionTodayStart = null;
    authPendingEmail = '';
    setAuthStep('email');
    setAuthStatus('');
    todayPlanStates = {};
    todayAdHocs = [];
    exerciseLibrary = [];
    exerciseLibraryByName = {};
    exerciseLibraryById = {};
    recentExercises = [];
    pickerState = { search: '', equipment: [], muscleGroup: [] };
    historyWeekCache = {};
    historyDetails = {};
    historyWeekStart = null;
    historyWeekLoading = false;
    historyView = 'week';
    earliestWorkoutDate = null;
    photosGoal = null;
    photosProgress = [];
    photosLoaded = false;
    photosSignedUrls = {};
    if (typeof resetCoachForSignOut === 'function') resetCoachForSignOut();
    document.body.classList.add('unauthed');
  }
}

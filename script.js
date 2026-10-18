/* =====================================================================
   ShadowBox Nox — منطق التطبيق (المرحلة 2)
   - كشف الجسم عبر MediaPipe Pose Landmarker (داخل المتصفح، بدون رفع صور)
   - عدّ اللكمات من حركة المعصم والذراع، لا من زر
   - أهداف على شكل قفاز تقترب منك، وتظهر واحدة جديدة بعد كل ضربة
   - حواجز تتجه نحو رأسك، عليك التفادي بالحركة
   - عربي / English، وحفظ الإعدادات محليًا
   ===================================================================== */

// ---------- روابط الموارد ----------
const MP_URL   = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
const STORAGE_KEY = "shadowbox_sessions_v1";
const PREFS_KEY = "shadowbox_prefs_v1";

// ---------- ثوابت الكشف عن اللكمات (قابلة للضبط) ----------
const CFG = {
  EXT_ON: 1.15,       // امتداد الذراع (بوحدة عرض الكتف) لاعتبارها ممدودة
  EXT_OFF: 1.05,      // أقل من هذا تُعتبر الذراع مسترخية
  Z_ON: 0.35,         // تقدّم المعصم نحو الكاميرا لاعتبار اللكمة أمامية
  Z_OFF: 0.25,        // أقل من هذا يُعتبر المعصم عائدًا
  SPEED_MIN: 2.2,     // أقل سرعة للمعصم (عرض كتف لكل ثانية)
  COOLDOWN_MS: 250,   // فترة صمت بين لكمتين من نفس اليد لمنع العدّ المزدوج
  REARM_MS: 350,      // بعد حكم على لكمة تُعاد تهيئة الذراع بعد هذه المدة حتى لو لم تعد للاسترخاء كليًا
  WINDOW_MS: 160,     // نافذة قياس السرعة
  VIS_MIN: 0.5,       // أقل درجة ظهور للمفصل
  SW_MIN: 0.10,       // أقل عرض كتف (نسبة لعرض الفيديو) للمعايرة
  SW_MAX: 0.6,        // أكبر عرض كتف مسموح (سُمح بالوقوف أقرب إلى الهاتف)
  READY_HOLD_MS: 3000,
};

// ---------- إعدادات الأهداف والأعمدة ----------
const TARGET_MS = 2200;        // زمن اقتراب القفاز من البعيد إلى القريب (السرعة المتوسطة)
const TARGET_GAP_MS = 700;     // انتظار قصير قبل ظهور القفاز التالي
const PILLAR_MS = 3000;        // زمن اقتراب الحاجز (السرعة المتوسطة)
const PILLAR_JUDGE_K = 0.92;   // لحظة الحكم على الحاجز (قرب الكاميرا)
const PILLAR_GAP_MIN = 4000;   // أقل فاصل بين حاجزين (مللي ثانية)
const PILLAR_GAP_RAND = 3000;  // زيادة عشوائية على الفاصل
const DODGE_GAP_MIN = 800;     // وضع المراوغة: فاصل أقصر بين الحواجز (حاجز واحد في كل مرة)
const DODGE_GAP_RAND = 1200;
let lastPillarHigh = null;     // آخر حاجز: true = للرأس، false = للجسم
const SEQ_LEN = 4;
const SEQ_BASE_MS = 1600;      // زمن الخطوة في التسلسل عند السرعة المتوسطة (ثابت لكل الخطوات في الجلسة)
const SPEED_MUL = { slow: 1.35, mid: 1, fast: 0.75 };  // مضاعِف زمن الاقتراب حسب اختيار السرعة
const LEVEL_MUL = { beginner: 1.2, intermediate: 1, advanced: 0.82 }; // مستوى ثابت في الحرّ؛ وضع التقدّم يرفع الصعوبة تدريجيًا
// حساسية الكشف: قيم حد السرعة وحد الامتداد (الأعلى = يتطلب لكمة أقوى)
const SENS = { low: { speed: 3.0, ext: 1.25 }, mid: { speed: 2.2, ext: 1.15 }, high: { speed: 1.7, ext: 1.05 } };
const MODE_LOGO = { free: "🥊", sequence: "🎯", dodge: "🛡️", progress: "📈" };

// ---------- النصوص: [عربي، English] ----------
const T = {
  splash_hint: ["اضغط للدخول", "Tap to enter"],
  tagline: ["كيس افتراضي يستجيب للكماتك، وعدّاد لكمات يعمل بكاميرا هاتفك", "A virtual bag that reacts to your punches, with a punch counter powered by your phone camera"],
  btn_settings: ["⚙️ الإعدادات", "⚙️ Settings"],
  banner_https: ["⚠️ الكاميرا لا تعمل إلا عبر <b>HTTPS</b>. افتح التطبيق من رابط يبدأ بـ https:// أو من localhost.", "⚠️ The camera only works over <b>HTTPS</b>. Open the app from an https:// link or localhost."],
  modes_title: ["اختر نوع التدريب", "Choose a training mode"],
  name_free: ["حرّ", "Free"],
  desc_free: ["أهداف عشوائية تقترب منك، اضرب كل واحد منها", "Random targets come toward you. Hit each one"],
  name_sequence: ["تسلسل", "Sequence"],
  desc_sequence: ["اتبع الكومبو: نوع الضربة واليد والمكان والسرعة", "Follow the combo: punch type, hand, zone and speed"],
  name_dodge: ["مراوغة", "Dodge"],
  desc_dodge: ["حواجز تتجه نحو رأسك، تفاداها بالحركة (بدون لكمات)", "Barriers aim at your head. Slip them by moving (no punches)"],
  name_progress: ["التقدّم", "Progress"],
  desc_progress: ["تزداد سرعة الأهداف تدريجيًا مع كل جولة", "Targets gradually get faster each round"],
  progress_hint: ["في وضع التقدّم، تزداد سرعة الأهداف تدريجيًا مع كل جولة.", "In Progress mode, targets gradually get faster each round."],
  btn_history: ["سجل التقدم الشخصي", "Personal progress"],
  btn_help: ["نصائح الإعداد", "Setup tips"],
  notice_privacy: ["🔒 <b>الخصوصية:</b> معالجة الفيديو تتم داخل متصفحك فقط. لا يتم رفع أي صورة من الكاميرا إلى أي خادم. السجل يُحفظ محليًا على جهازك.", "🔒 <b>Privacy:</b> video is processed only inside your browser. No camera image is uploaded to any server. History is saved locally on your device."],
  notice_accuracy: ["ℹ️ كشف اللكمات تقديري من كاميرا واحدة، وقد يخطئ مع الحركات السريعة جدًا أو الإضاءة الضعيفة. راجع «نصائح الإعداد» للحصول على أفضل دقة.", "ℹ️ Punch detection is an estimate from one camera and may miss very fast moves or poor lighting. See “Setup tips” for best accuracy."],
  setup_title: ["إعدادات الجلسة", "Session settings"],
  setup_group_time: ["الوقت والجولات", "Time and rounds"],
  setup_group_control: ["الصعوبة وحساسية اللكمات", "Difficulty and punch detection"],
  rest_add20: ["+20 ثانية", "+20 seconds"],
  setup_group_position: ["الوضعية والكاميرا", "Stance and camera"],
  btn_back: ["رجوع", "Back"],
  btn_start: ["ابدأ التدريب", "Start training"],
  btn_preparing: ["جارٍ تجهيز الكاميرا...", "Preparing camera..."],
  field_round_len: ["مدة الجولة", "Round length"],
  field_rounds: ["عدد الجولات", "Number of rounds"],
  field_rest: ["الراحة بين الجولات", "Rest between rounds"],
  field_speed: ["سرعة الأهداف", "Target speed"],
  field_stance: ["وضعية الوقوف", "Stance"],
  field_camera: ["الكاميرا", "Camera"],
  dur_3: ["3 دقائق", "3 minutes"],
  dur_5: ["5 دقائق", "5 minutes"],
  dur_7: ["7 دقائق", "7 minutes"],
  dur_10: ["10 دقائق", "10 minutes"],
  field_level: ["مستوى الصعوبة", "Difficulty level"],
  level_beginner: ["مبتدئ", "Beginner"],
  level_intermediate: ["متوسط", "Intermediate"],
  level_advanced: ["متقدم", "Advanced"],
  rounds_1: ["جولة واحدة", "1 round"],
  rounds_2: ["جولتان", "2 rounds"],
  rounds_3: ["3 جولات", "3 rounds"],
  rounds_4: ["4 جولات", "4 rounds"],
  rounds_6: ["6 جولات", "6 rounds"],
  lbl_show: ["إظهار التوضيح", "Show hints"],
  lbl_hide: ["إخفاء التوضيح", "Hide hints"],
  field_sens: ["حساسية الكشف", "Detection sensitivity"],
  sens_low: ["منخفضة (تتطلب لكمة قوية)", "Low (needs strong punches)"],
  sens_mid: ["متوسطة", "Medium"],
  sens_high: ["عالية (تقبل لكمات أخف)", "High (accepts lighter punches)"],
  field_count: ["احتساب اللكمات", "Count punches"],
  count_targets: ["على الأهداف فقط", "Only on targets"],
  count_all: ["كل لكمة في الهواء أيضًا", "Every punch, including air"],
  rounds_12: ["12 جولة", "12 rounds"],
  rest_0: ["بدون راحة", "No rest"],
  rest_30: ["30 ثانية", "30 seconds"],
  rest_60: ["دقيقة", "1 minute"],
  rest_90: ["دقيقة ونصف", "1.5 minutes"],
  speed_slow: ["بطيء", "Slow"],
  speed_mid: ["متوسط", "Medium"],
  speed_fast: ["سريع", "Fast"],
  stance_orth: ["اليد اليسرى أمامية (عادية)", "Left hand forward (orthodox)"],
  stance_south: ["اليد اليمنى أمامية (معاكسة)", "Right hand forward (southpaw)"],
  cam_front: ["الأمامية (مفضّلة للتدريب)", "Front (recommended)"],
  cam_back: ["الخلفية", "Back"],
  settings_title: ["الإعدادات", "Settings"],
  field_lang: ["اللغة", "Language"],
  field_theme: ["الثيم", "Theme"],
  theme_red: ["أحمر", "Red"],
  theme_blue: ["أزرق", "Blue"],
  theme_green: ["أخضر", "Green"],
  theme_purple: ["بنفسجي", "Purple"],
  theme_gold: ["ذهبي", "Gold"],
  advanced_hint: ["المتقدم يجعل الأهداف أسرع؛ اختره بعد إتقان المتوسط.", "Advanced makes targets move faster; try it after getting comfortable with intermediate."],
  toggle_sound: ["تفعيل الأصوات والتأثيرات الصوتية", "Sound effects"],
  btn_reset_history: ["حذف السجل المحفوظ", "Clear saved history"],
  btn_close: ["إغلاق", "Close"],
  btn_ok: ["حسنًا", "OK"],
  status_calib: ["معايرة", "Calibration"],
  status_round: ["تسجيل نشط", "Recording"],
  status_rest: ["راحة", "Rest"],
  status_paused: ["متوقف", "Paused"],
  status_done: ["انتهى", "Finished"],
  round_label: ["الجولة {n}/{m}", "Round {n}/{m}"],
  unit_punch: ["لكمة", "punches"],
  stat_jab: ["جاب", "Jab"],
  stat_right: ["يمنى", "Right"],
  stat_left: ["يسرى", "Left"],
  stat_targets: ["أهداف القفاز", "Glove targets"],
  stat_ppm: ["لكمة/دقيقة", "Punches/min"],
  stat_cross: ["كروس", "Cross"],
  stat_hits: ["ضربات مستلمة", "Hits taken"],
  stat_dodges: ["تفادٍ ناجح", "Successful dodges"],
  btn_hide_stats: ["إخفاء النتائج", "Hide stats"],
  btn_show_stats: ["إظهار النتائج", "Show stats"],
  ctrl_left: ["يسار أمامي", "Left lead"],
  ctrl_right: ["يمين أمامي", "Right lead"],
  btn_rotate: ["⟳ تدوير", "⟳ Rotate"],
  btn_cam: ["🔄 كاميرا", "🔄 Camera"],
  btn_end: ["إنهاء", "End"],
  calib_title: ["معايرة الوضعية", "Pose calibration"],
  calib_hint: ["قف على بعد مناسب بحيث يظهر جسمك من الكتفين حتى اليدين، واجعل الإضاءة من أمامك.", "Stand at a distance where your body shows from shoulders to hands, with light in front of you."],
  calib_searching: ["جارٍ البحث عن جسمك...", "Looking for your body..."],
  calib_none: ["لم يتم اكتشاف جسمك بعد. تأكد من الإضاءة وأن الكاميرا تظهر جسمك.", "Your body isn't detected yet. Check the lighting and that the camera can see you."],
  calib_show: ["أظهر كتفيك ويديك كاملتين داخل الإطار", "Show both shoulders and hands fully in the frame"],
  calib_closer: ["اقترب قليلًا من الكاميرا", "Move a little closer to the camera"],
  calib_back: ["ابتعد قليلًا عن الكاميرا", "Move a little back from the camera"],
  calib_ok: ["ممتاز! جسمك واضح داخل الإطار", "Great! Your body is clearly in the frame"],
  countdown: ["استعد... {n}", "Get ready... {n}"],
  btn_start_round: ["ابدأ الجولة", "Start round"],
  rest_title: ["راحة", "Rest"],
  rest_next: ["الجولة {n} ستبدأ بعد الراحة", "Round {n} starts after the rest"],
  btn_skip_rest: ["إنهاء الراحة", "End rest"],
  pause_title: ["متوقف مؤقتًا", "Paused"],
  pause_hint: ["لن تُحتسب اللكمات أثناء الإيقاف.", "Punches are not counted while paused."],
  btn_resume: ["متابعة", "Resume"],
  res_title: ["نتيجة الجلسة 🥊", "Session result 🥊"],
  btn_again: ["جلسة جديدة", "New session"],
  btn_home: ["الرئيسية", "Home"],
  res_total: ["إجمالي اللكمات", "Total punches"],
  res_ppm: ["لكمة/دقيقة", "Punches/min"],
  res_time: ["وقت التدريب", "Training time"],
  res_targets: ["أهداف القفاز", "Glove targets"],
  res_dodges: ["تفادٍ ناجح", "Successful dodges"],
  res_hits: ["ضربات مستلمة", "Hits taken"],
  res_combos: ["تسلسلات مكتملة", "Combos completed"],
  res_wrong: ["يد خاطئة", "Wrong hand"],
  res_left: ["يسرى", "Left"],
  res_right: ["يمنى", "Right"],
  res_jab: ["جاب", "Jab"],
  res_cross: ["كروس", "Cross"],
  res_none: ["لم تُسجَّل أي لكمة. تأكد من ظهور كتفيك ويديك، ثم حاول مرة أخرى.", "No punches recorded. Make sure your shoulders and hands are visible, then try again."],
  res_note: ["العدّاد تقديري ويعتمد على كاميرا واحدة. تم حفظ الجلسة محليًا.", "The counter is an estimate based on one camera. The session was saved locally."],
  kind_jab: ["جاب", "Jab"],
  kind_cross: ["كروس", "Cross"],
  hand_left: ["يسرى", "Left"],
  hand_right: ["يمنى", "Right"],
  fl_wrong: ["يد خاطئة ✖", "Wrong hand ✖"],
  fl_hit: ["ضربة ✖", "Hit ✖"],
  fl_dodge: ["تفادٍ ✓", "Dodged ✓"],
  fl_target: ["+1 🥊", "+1 🥊"],
  toast_front: ["الكاميرا الأمامية", "Front camera"],
  toast_back: ["الكاميرا الخلفية", "Back camera"],
  toast_cam_fail: ["تعذر تبديل الكاميرا", "Could not switch camera"],
  toast_rot: ["التدوير: {d}°", "Rotation: {d}°"],
  toast_left_lead: ["اليد اليسرى أمامية", "Left hand leads"],
  toast_right_lead: ["اليد اليمنى أمامية", "Right hand leads"],
  seq_prep: ["جارٍ التحضير...", "Preparing..."],
  seq_line: ["{i}/{n} · {kind} {hand} · {zone} · {speed}", "{i}/{n} · {kind} {hand} · {zone} · {speed}"],
  pos_high: ["أعلى", "Upper"],
  pos_low: ["أسفل", "Lower"],
  pos_left: ["يسار", "left"],
  pos_center: ["وسط", "center"],
  pos_right: ["يمين", "right"],
  spd_fast: ["سريع", "Fast"],
  spd_mid: ["متوسط", "Medium"],
  spd_slow: ["بطيء", "Slow"],
  err_https: ["يجب فتح التطبيق عبر HTTPS (أو localhost) لتعمل الكاميرا.", "The app must be opened over HTTPS (or localhost) for the camera to work."],
  err_no_api: ["هذا المتصفح لا يدعم الوصول إلى الكاميرا.", "This browser doesn't support camera access."],
  err_perm: ["تم رفض إذن الكاميرا. فعّله من إعدادات المتصفح ثم أعد المحاولة.", "Camera permission was denied. Enable it in browser settings and try again."],
  err_notfound: ["لم يتم العثور على كاميرا في هذا الجهاز.", "No camera was found on this device."],
  err_busy: ["الكاميرا مستخدمة من تطبيق آخر. أغلقه ثم أعد المحاولة.", "The camera is in use by another app. Close it and try again."],
  err_generic: ["تعذر تشغيل التطبيق: {msg}. تأكد من اتصال الإنترنت (لتحميل نموذج الرؤية) ومن فتح الصفحة عبر HTTPS.", "Couldn't start the app: {msg}. Check your internet connection (to load the pose model) and that the page is opened over HTTPS."],
  err_unknown: ["خطأ غير معروف", "unknown error"],
  hist_title: ["سجل التقدم الشخصي", "Personal progress"],
  hist_acc: ["دقة {a}%", "{a}% accuracy"],
  prog_best_acc: ["أفضل دقة", "Best accuracy"],
  prog_rounds: ["جولات مكتملة", "Rounds completed"],
  res_acc: ["دقة اللكمات", "Punch accuracy"],
  res_hit: ["إصابات", "Landed"],
  res_miss: ["أخطاء", "Missed"],
  res_acc_pct: ["نسبة الدقة", "Accuracy"],
  res_avg_hit: ["متوسط وقت الإصابة", "Avg time to hit"],
  res_rounds: ["جولات مكتملة", "Rounds completed"],
  coach_tip_accuracy: ["دقتك في لمس الأهداف منخفضة. ركّز على لمس القفاز بقبضتك قبل زيادة السرعة.", "Your target accuracy is low. Focus on landing the glove with your fist before increasing speed."],
  coach_pose_title: ["مؤشرات الوضعية من الكاميرا", "Camera-based posture signals"],
  coach_pose_guard: ["مؤشر انخفاض اليدين بين اللكمات", "Hands-down signal between punches"],
  coach_pose_lean: ["مؤشر ميل الجذع", "Torso-lean signal"],
  coach_pose_unavailable: ["لم تتوفر عينات كافية لتحليل الوضعية في هذه الجلسة.", "There were not enough pose samples to analyze posture in this session."],
  coach_tip_guard: ["مؤشر الكاميرا يوحي أن يديك تنخفضان كثيرًا بين اللكمات. جرّب إرجاعهما إلى وضع الحراسة بعد كل ضربة؛ التقدير تقريبي.", "Camera samples suggest your hands may drop between punches. Practice returning them to guard after each punch; this estimate is approximate."],
  coach_tip_balance: ["رصدت الكاميرا ميلًا جانبيًا متكررًا للجذع. جرّب الوقوف بتوازن وحرّك رأسك بهدوء دون مبالغة؛ هذا مؤشر تقريبي.", "The camera repeatedly detected a sideways torso lean. Try a balanced stance and controlled head movement; this is only an approximate signal."],
  hist_sessions: ["جلسة", "sessions"],
  hist_punches: ["لكمة إجمالًا", "total punches"],
  hist_minutes: ["دقيقة تدريب", "training minutes"],
  hist_best: ["أفضل معدل/دقيقة", "best punches/min"],
  hist_empty: ["لا توجد جلسات محفوظة بعد.", "No saved sessions yet."],
  hist_line: ["{r} جولة · {t} · {s}", "{r} rounds · {t} · {s}"],
  hist_summary: ["{p}/د · {g} قفاز · {d} تفادٍ", "{p}/min · {g} gloves · {d} dodges"],
  btn_clear_history: ["حذف السجل", "Delete history"],
  hist_confirm: ["هل تريد حذف كل السجل المحفوظ على هذا الجهاز؟", "Delete all saved history on this device?"],
  pb_title: ["دقة اللكمات حسب النوع", "Accuracy by punch type"],
  pb_jab: ["جاب", "Jab"],
  pb_cross: ["كروس", "Cross"],
  pb_dodge: ["تفادٍ", "Dodges"],
  pb_legend_hit: ["ناجح", "Success"],
  pb_legend_miss: ["خطأ", "Miss"],
  pb_overall: ["نسبة الدقة الإجمالية", "Overall accuracy"],
  nav_training: ["التمرين", "Training"],
  nav_training_desc: ["الحر والتسلسل والمراوغة", "Free, sequence and dodge"],
  nav_learn: ["التعلّم", "Learn"],
  nav_learn_desc: ["الكومبوهات وحركة القدمين والدفاع", "Combos, footwork and defense"],
  nav_coach_desc: ["تحليل محلي لجلساتك واقتراح تمارين", "Local analysis of your sessions and suggested drills"],
  nav_activity: ["سجل النشاط", "Activity log"],
  nav_activity_desc: ["السجل والإحصائيات وتقدمك الشخصي", "History, stats and your progress"],
  learn_combos_t: ["الكومبوهات", "Combos"],
  learn_combos_1: ["ابدأ بجاب ثم كروس، ثم أضف خطافًا أماميًا. كرّر الكومبو ببطء قبل زيادة السرعة.", "Start with a jab, then a cross, then add a lead hook. Repeat slowly before increasing speed."],
  learn_combos_2: ["حافظ على إيقاع ثابت في الكومبو، ولا تبالغ في القوة على حساب التوازن.", "Keep a steady rhythm in combos. Don't overpower at the cost of balance."],
  learn_feet_t: ["حركة القدمين", "Footwork"],
  learn_feet_1: ["ابقَ على رؤوس أصابعك، وانقل وزنك بين القدمين بخفة.", "Stay on the balls of your feet and shift weight lightly between them."],
  learn_feet_2: ["لا تُباعد قدميك كثيرًا، فتفقد التوازن والسرعة.", "Don't spread your feet too far, or you lose balance and speed."],
  learn_def_t: ["الدفاع", "Defense"],
  learn_def_1: ["أبقِ قبضتيك قرب وجهك دائمًا، وذقنك مائلًا قليلًا للأسفل.", "Keep your fists near your face at all times, with your chin slightly down."],
  learn_def_2: ["تفادَ بتحريك الرأس والجسم، لا بالتراجع وحده.", "Slip by moving your head and body, not by stepping back alone."],
  learn_note: ["هذه نصائح عامة للمبتدئين، وليست تحليلًا لحركتك.", "These are general beginner tips, not an analysis of your movement."],
  coach_chat_title: ["اسأل المدرّب", "Ask the coach"],
  coach_chat_send: ["إرسال", "Send"],
  coach_chat_retry: ["إعادة المحاولة", "Retry"],
  coach_chat_offline: ["خدمة الذكاء الاصطناعي غير متصلة بعد. ستظهر الإجابات هنا بعد ربط الخادم.", "The AI service is not connected yet. Answers will appear here once the server is linked."],
  coach_chat_loading: ["جارٍ البحث والتفكير...", "Searching and thinking..."],
  coach_chat_error: ["تعذّر الحصول على إجابة. حاول مرة أخرى.", "Could not get an answer. Please try again."],
  coach_chat_timeout: ["انتهت مهلة الطلب. حاول مرة أخرى.", "The request timed out. Please try again."],
  coach_chat_long: ["السؤال طويل جدًا، اختصره.", "Question is too long. Please shorten it."],
  coach_chat_ph: ["اسأل عن الملاكمة: تاريخها، تقنياتها، تدريبك...", "Ask about boxing: history, techniques, training..."],
  coach_chat_sources: ["المصادر", "Sources"],
  coach_chat_note: ["المدرّب يعمل محليًا بقواعد تدريبية واضحة ويستخدم أرقام جلساتك المحفوظة فقط؛ لا يراقب الكاميرا ولا يرسل بياناتك إلى خادم.", "The coach runs locally using clear training rules and your saved session stats only; it does not analyze the camera or send your data to a server."],
  coach_quick_session: ["قيّم آخر جلسة", "Review my last session"],
  coach_quick_combo: ["أعطني كومبو للمبتدئين", "Give me a beginner combo"],
  coach_quick_accuracy: ["كيف أحسّن دقة اللكمات؟", "How can I improve punch accuracy?"],
  coach_quick_defense: ["علّمني أساسيات الدفاع", "Teach me basic defense"],
  coach_quick_progress: ["كيف أطور نفسي حسب تقدمي؟", "How can I improve based on my progress?"],
  coach_name: ["المدرّب الذكي", "AI Coach"],
  coach_desc: ["تحليل جلساتك واقتراح تمارين مناسبة", "Analyzes your sessions and suggests drills"],
  coach_title: ["المدرّب الذكي 🧠", "AI Coach 🧠"],
  coach_empty: ["أكمل جلسة واحدة على الأقل ليبدأ المدرّب بتحليل أدائك.", "Complete at least one session so the coach can analyze your performance."],
  coach_note: ["المدرّب يحلل أرقام الجلسات وبعض مؤشرات وضعية الجسم المحسوبة محليًا من نقاط الهيكل؛ لا تُرفع صور الكاميرا. المؤشرات تقريبية وليست حكمًا احترافيًا على التقنية.", "The coach analyzes session stats and a few posture indicators computed locally from pose landmarks. Camera images are not uploaded. These estimates are not a professional technique assessment."],
  coach_stat_sessions: ["جلسات محللة", "sessions analyzed"],
  coach_stat_ppm: ["متوسط لكمات/دقيقة", "avg punches/min"],
  coach_stat_glove: ["دقة القفاز", "glove accuracy"],
  coach_stat_dodge: ["نسبة التفادي", "dodge rate"],
  coach_tips_title: ["توصيات لجلستك القادمة", "Recommendations for your next session"],
  coach_tip_speed: ["متوسط سرعتك منخفض. حافظ على إيقاع ثابت للكمات، وابدأ بجولات قصيرة بسرعة متوسطة.", "Your pace is low. Keep a steady punch rhythm and start with shorter rounds at medium speed."],
  coach_tip_dodge: ["نسبة تفاديك للحواجز منخفضة. جرّب وضع «مراوغة» وركّز على حركة الرأس والجسم.", "Your dodge rate is low. Try Dodge mode and focus on head and body movement."],
  coach_tip_cross: ["تستعمل الكروس قليلًا. تدرّب على تركيبات جاب-كروس متكررة لتوازن لكماتك.", "You throw few crosses. Practice repeated jab-cross combinations to balance your punches."],
  coach_tip_sequence: ["أخطاء اليد كثيرة في التسلسل. جرّب وضع «تسلسل» ببطء لتحسين تمييز اليدين.", "Many wrong-hand errors. Try Sequence mode at slow speed to sharpen hand recognition."],
  coach_tip_improving: ["تحسّن معدل لكماتك في آخر جلسة مقارنة بالسابقة، استمر على هذا النهج.", "Your punch rate improved in your last session. Keep it up."],
  coach_tip_good: ["أداؤك متوازن. حافظ على الانتظام وزِد مدة الجولة تدريجيًا.", "Your performance is balanced. Stay consistent and gradually increase round length."],
  help_title: ["نصائح للحصول على أفضل دقة", "Tips for better accuracy"],
  help_1: ["ضع الهاتف على حامل ثابت على ارتفاع الصدر تقريبًا، ويفضّل أن يكون بعيدًا عنك بمترين تقريبًا.", "Put the phone on a stable stand at about chest height, roughly two meters away."],
  help_2: ["يجب أن يظهر <b>كتفاك ويداك كاملتان</b> داخل الإطار. الأرجل والوركان غير ضروريين.", "Your <b>shoulders and both hands</b> must be inside the frame. Legs and hips are not required."],
  help_3: ["استخدم إضاءة أمامية جيدة، وتجنب الوقوف أمام نافذة أو ضوء خلفك.", "Use good front lighting and avoid standing in front of a window or with a light behind you."],
  help_4: ["الكاميرا الأمامية تعكس الصورة كالمرآة، وهذا طبيعي.", "The front camera mirrors the image, like a mirror. That is normal."],
  help_5: ["اللكمات المستقيمة نحو الكاميرا تُكتشف عبر تغيّر العمق، لذا قد تحتاج لتجربة مسافة مختلفة.", "Straight punches toward the camera are detected by depth change, so you may need to try a different distance."],
  help_6: ["إذا كانت اللكمات تُعد مرتين، زد مدة الانتظار بتعديل الثوابت في أعلى ملف <b>script.js</b>.", "If punches count twice, adjust the constants at the top of <b>script.js</b>."],
  help_7: ["إذا لم تُعد اللكمات، جرّب تقليل <b>SPEED_MIN</b> أو تقليل <b>EXT_ON</b> في نفس الملف.", "If punches are not counted, try lowering <b>SPEED_MIN</b> or <b>EXT_ON</b> in the same file."],
  help_limit: ["حدود النظام: كاميرا واحدة لا تقيس العمق بدقة، لذلك فالتمييز بين الجاب والكروس والكشف عن اللكمات المستقيمة تقديري.", "System limits: one camera cannot measure depth precisely, so telling jab from cross and detecting straight punches is an estimate."],
};

// يعيد النص باللغة الحالية، ويستبدل {متغيرات}
function t(key, vars) {
  const pair = T[key];
  let s = pair ? pair[lang === "en" ? 1 : 0] : key;
  if (vars) for (const k in vars) s = s.split(`{${k}}`).join(String(vars[k]));
  return s;
}

// ---------- مساعدات DOM ----------
const $ = (id) => document.getElementById(id);
const IDS = [
  "homeScreen", "setupScreen", "trainScreen", "cam", "stage",
  "roundSec", "roundCount", "restSec", "levelSel", "speedSel", "stanceSel", "facingSel", "soundToggle",
  "btnStart", "btnHistory", "btnHelp", "btnSettings", "btnSetupBack", "homeMsg", "banner",
  "setupTitle", "setupLogo", "progressHint",
  "roundLabel", "timer", "statusPill", "total", "leftCount", "rightCount",
  "jabCount", "crossCount", "ppm", "targetHits", "dodges", "pillarHits",
  "btnPause", "btnStance", "btnCam", "btnRotate", "btnStop", "toast",
  "calibOverlay", "calibStatus", "calibBtn", "calibCancel",
  "restOverlay", "restCount", "restNext", "restSkip", "restAdd20",
  "pauseOverlay", "btnResume",
  "resultOverlay", "resultBody", "btnAgain", "btnHome",
  "historyModal", "historyBody", "btnClearHistory", "btnCloseHistory",
  "helpModal", "btnCloseHelp", "seqPrompt", "btnStats", "btnLabels", "sensSel", "countSel", "splash",
  "settingsModal", "langSel", "themeSel", "btnCloseSettings", "btnResetHistory",
  "btnCoach", "coachModal", "coachBody", "btnCloseCoach",
  "btnTraining", "btnLearn", "trainMenuScreen", "learnScreen", "btnTrainBack", "btnLearnBack",
  "coachChatForm", "coachChatInput", "coachChatSend", "coachChatLog", "coachChatStatus", "coachRetry",
];
const el = {};
for (const id of IDS) el[id] = $(id);

const ctx = el.stage.getContext("2d");

// ---------- الحالة العامة ----------
const STATUS_KEYS = { calib: "status_calib", round: "status_round", rest: "status_rest", paused: "status_paused", done: "status_done" };

let lang = "ar";                 // ar | en
let prefs = {};                  // الإعدادات المحفوظة محليًا
let landmarker = null;
let stream = null;
let mirror = true;               // الكاميرا الأمامية تُعكس كالمرآة
let facingMode = "user";
let state = "home";              // home | calib | round | rest | paused | done
let stance = "orthodox";
let pendingMode = "free";        // نوع التدريب المختار من البطاقات: free | sequence | dodge
let mode = "free";               // النوع الفعلي للجلسة الحالية
let speedMul = 1;                // مضاعِف السرعة للجلسة الحالية
let seq = [];                    // التسلسل الحالي: [{kind, hand, lane, high, spd, ms}]
let seqIdx = 0;
let statsHidden = true;        // القائمة مخفية افتراضيًا
let labelsOn = false;            // توضيح نوع اللكمة مخفي افتراضيًا
let sessionSpeed = "mid";        // سرعة الجلسة: slow | mid | fast
let sessionLevel = "intermediate"; // مستوى الصعوبة المختار للوضع الحر؛ ثابت طوال الجلسة
let speedMinNow = CFG.SPEED_MIN;  // حد السرعة للجلسة الحالية (حسب الحساسية)
let extOnNow = CFG.EXT_ON;        // حد الامتداد للجلسة الحالية (حسب الحساسية)
let countTargetsOnly = false;     // الحرّ: احتساب اللكمات على الأهداف فقط
let soundOn = true;

let totalRounds = 3, currentRound = 1;
let roundDurMs = 180000, roundMs = 0;
let restDurMs = 0, restMs = 0;
let activeMs = 0;                // زمن الجولات الفعلي فقط

let stats = freshStats();
let hands = { left: freshHand(), right: freshHand() };
let lastCoachSampleAt = 0;

let lastPose = null;             // آخر مجموعة نقاط للجسم بعد التنعيم الزمني
let smoothedPose = null;         // يقلل اهتزاز الهيكل بين الإطارات
let poseSW = 0;                  // عرض الكتفين بالبكسل (في فضاء الفيديو)
let stableSince = 0, calibReady = false;
let countdownMs = -1;            // العد التنازلي قبل الجولة (-1 = غير نشط)

let lastTs = 0, rafId = 0;
let lastDetectTs = -1;           // آخر طابع وقت أُرسل للكشف (يجب أن يكون متزايدًا)
let vw = 0, vh = 0;              // أبعاد الفيديو
let cw = 0, ch = 0, dpr = 1;     // أبعاد الـ canvas (CSS px)
let scale = 1, offX = 0, offY = 0;
let dw = 0, dh = 0;              // أبعاد الصورة بعد التدوير (كما تُعرض على الشاشة)
let rot = 0;                     // التدوير: 0 | 1 (90°) | 2 (180°) | 3 (270°)
let rotAuto = false;             // التدوير التلقائي حتى يضغط المستخدم زر التدوير
let videoKey = "";               // لتجنب تحديث عنصر الفيديو دون داع

let floaters = [];
let targets = [];                // أهداف القفاز: {state: live|hit|miss, lane, k, age}
let pillars = [];                // الحواجز: {lane, k, judged}
let nextTargetAt = 0, nextPillarAt = 0;
let lastTargetLane = null;       // آخر عمود ظهر فيه قفاز (لتجنب التكرار)
let flashRed = 0;                // وميض أحمر عند ضربة من حاجز
let audioCtx = null;
let toastTimer = 0;

function freshStats() {
  return { total: 0, left: 0, right: 0, jab: 0, cross: 0, hits: 0,
           targetHits: 0, targetMiss: 0, dodges: 0, pillarHits: 0, seqDone: 0, wrongHand: 0,
           punchHit: 0, punchMiss: 0, missJab: 0, missCross: 0, hitJab: 0, hitCross: 0, reactSum: 0, reactN: 0, roundsDone: 0,
           poseSamples: 0, lowGuardSamples: 0, leanSamples: 0 };
}
function freshHand() {
  return { armed: true, hist: [], lastPunch: -1e9, lastJudge: -1e9, contactUntil: 0, ep: freshEpisode() };
}
function freshEpisode() {
  return { active: false, start: 0, hit: false, targeted: false, type: "" };
}
function resetHands() {
  hands.left = freshHand();
  hands.right = freshHand();
}
function dropHandTracking() {
  for (const s of ["left", "right"]) {
    hands[s].hist = [];
    hands[s].armed = true;
    hands[s].ep = freshEpisode();
  }
}
function pickLane() {
  return [-1, 0, 1][Math.floor(Math.random() * 3)];
}
// أهداف ذكية: لا تكرر العمود نفسه، وتفضّل الجهة البعيدة عن ميل جسمك لتضطر إلى الوصول إليها
function leanSide() {
  if (!lastPose || !poseSW || !cw) return 0;
  if (!lastPose[11] || !lastPose[12]) return 0;
  const dx = (bodyCenterX() - cw / 2) / (cw * 0.2);
  return Math.abs(dx) < 0.25 ? 0 : Math.max(-1, Math.min(1, dx));
}
function pickTargetLane() {
  const lean = leanSide();
  const lanes = [-1, 0, 1].filter((l) => l !== lastTargetLane);
  const weights = lanes.map((l) => (lean !== 0 && l * lean < 0 ? 2 : 1));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  let pick = lanes[lanes.length - 1];
  for (let i = 0; i < lanes.length; i++) {
    r -= weights[i];
    if (r < 0) { pick = lanes[i]; break; }
  }
  lastTargetLane = pick;
  return pick;
}

// ---------- أدوات عامة ----------
function setText(node, value) {
  const s = String(value);
  if (node.textContent !== s) node.textContent = s;
}
function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString(lang === "en" ? "en" : "ar", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}
function setHomeMsg(text, isError = false) {
  el.homeMsg.textContent = text;
  el.homeMsg.classList.toggle("error", isError);
}
function showToast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 2200);
}
// الشاشات: home (الرئيسية) | trainMenu (التمرين) | learn (التعلّم) | setup (إعدادات الجلسة) | train (التدريب)
function showScreen(name) {
  el.homeScreen.classList.toggle("active", name === "home");
  el.trainMenuScreen.classList.toggle("active", name === "trainMenu");
  el.learnScreen.classList.toggle("active", name === "learn");
  el.setupScreen.classList.toggle("active", name === "setup");
  el.trainScreen.classList.toggle("active", name === "train");
}
function addFloater(text, x, y, color = "#ffffff", kind = "") {
  floaters.push({ text, x, y, color, kind, born: performance.now() });
}

// ---------- الإعدادات المحفوظة (اللغة، الصوت، آخر اختيارات الجلسة) ----------
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY));
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}
function savePrefs() {
  prefs = {
    lang,
    sound: el.soundToggle.checked,
    roundSec: el.roundSec.value,
    roundCount: el.roundCount.value,
    restSec: el.restSec.value,
    level: el.levelSel.value,
    speed: el.speedSel.value,
    stance: el.stanceSel.value,
    facing: el.facingSel.value,
    sens: el.sensSel.value,
    count: el.countSel.value,
    theme: el.themeSel.value,
  };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}
function applyPrefs() {
  prefs = loadPrefs();
  const pick = (node, v) => { if (v !== undefined && [...node.options].some((o) => o.value === String(v))) node.value = String(v); };
  pick(el.roundSec, prefs.roundSec);
  pick(el.roundCount, prefs.roundCount);
  pick(el.restSec, prefs.restSec);
  pick(el.levelSel, prefs.level || "intermediate");
  pick(el.speedSel, prefs.speed);
  pick(el.stanceSel, prefs.stance);
  pick(el.facingSel, prefs.facing);
  pick(el.sensSel, prefs.sens);
  pick(el.countSel, prefs.count);
  pick(el.themeSel, prefs.theme || "red");
  applyTheme(el.themeSel.value || "red");
  if (typeof prefs.sound === "boolean") el.soundToggle.checked = prefs.sound;
  lang = prefs.lang === "en" ? "en" : "ar";
}

// ---------- اللغة: تطبيق النصوص على الواجهة كلها ----------
function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-i18n]").forEach((n) => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll("[data-i18n-html]").forEach((n) => { n.innerHTML = t(n.dataset.i18nHtml); });
  el.langSel.value = lang;
  setSetupMode();
  setStatsHidden(statsHidden);
  setLabels(labelsOn);
  updateHud();
}
function setLang(v) {
  lang = v === "en" ? "en" : "ar";
  savePrefs();
  applyLang();
}
function applyTheme(v) {
  const allowed = ["red", "blue", "green", "purple", "gold"];
  document.documentElement.dataset.theme = allowed.includes(v) ? v : "red";
}
function setTheme(v) {
  applyTheme(v);
  savePrefs();
}

// ---------- الصوت (WebAudio، بدون ملفات خارجية) ----------
function getAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      audioCtx = null;
    }
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
function tone(freq, dur, vol = 0.15, type = "sine") {
  if (!soundOn) return;
  const ac = getAudio();
  if (!ac) return;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.value = vol;
  g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
  o.connect(g).connect(ac.destination);
  o.start();
  o.stop(ac.currentTime + dur);
}

// ---------- تحميل نموذج الرؤية ----------
async function ensureLandmarker() {
  if (landmarker) return;
  const { PoseLandmarker, FilesetResolver } = await import(MP_URL);
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.55,
    minPosePresenceConfidence: 0.55,
    minTrackingConfidence: 0.6,
  });
  try {
    landmarker = await PoseLandmarker.createFromOptions(vision, opts("GPU"));
  } catch (err) {
    console.warn("GPU غير متاح، نعود إلى CPU:", err);
    landmarker = await PoseLandmarker.createFromOptions(vision, opts("CPU"));
  }
}

// ---------- الكاميرا ----------
async function openCamera() {
  stopCamera();
  if (!window.isSecureContext) {
    throw new Error(t("err_https"));
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(t("err_no_api"));
  }
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      // الهاتف عمودي، لذلك نطلب صورة عمودية حتى تظهر الذراعان كاملتين
      width: { ideal: 720 },
      height: { ideal: 1280 },
    },
  });
  const track = stream.getVideoTracks()[0];
  const reported = track?.getSettings?.().facingMode;
  mirror = (reported ?? facingMode) === "user";

  // الفيديو يظهر فعلًا (وليس مخفيًا)، والـ canvas فوقه يرسم الأهداف والهيكل
  el.cam.muted = true;
  el.cam.srcObject = stream;
  if (el.cam.readyState < 1) {
    await new Promise((resolve) => el.cam.addEventListener("loadedmetadata", resolve, { once: true }));
  }
  try {
    await el.cam.play();
  } catch (e) {
    console.warn(e);
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((tr) => tr.stop());
    stream = null;
  }
  el.cam.srcObject = null;
}

async function switchCamera() {
  facingMode = facingMode === "user" ? "environment" : "user";
  try {
    await openCamera();
    resetHands();
    lastPose = null;
    resizeCanvas();
    showToast(mirror ? t("toast_front") : t("toast_back"));
  } catch (err) {
    console.error(err);
    showToast(t("toast_cam_fail"));
  }
}

function describeError(err) {
  const name = err?.name;
  if (name === "NotAllowedError") return t("err_perm");
  if (name === "NotFoundError") return t("err_notfound");
  if (name === "NotReadableError") return t("err_busy");
  if (err?.message?.includes("HTTPS")) return err.message;
  return t("err_generic", { msg: err?.message || t("err_unknown") });
}

// ---------- الإعدادات ----------
function readSettings() {
  rotAuto = false;
  rot = 0;
  autoRotKey = "";
  videoKey = "";
  stance = el.stanceSel.value;
  mode = pendingMode;
  sessionLevel = el.levelSel.value || "intermediate";
  sessionSpeed = ({ beginner: "slow", intermediate: "mid", advanced: "fast" })[sessionLevel] || "mid";
  const sens = SENS[el.sensSel.value] ?? SENS.mid;
  speedMinNow = sens.speed;
  extOnNow = sens.ext;
  countTargetsOnly = el.countSel.value === "targets";
  speedMul = LEVEL_MUL[sessionLevel] ?? 1;
  facingMode = el.facingSel.value;
  soundOn = el.soundToggle.checked;
  roundDurMs = Number(el.roundSec.value) * 1000;
  totalRounds = Number(el.roundCount.value);
  restDurMs = 60000;
}

// ---------- اختيار نوع التدريب وشاشة الإعدادات ----------
function setSetupMode() {
  el.setupScreen.dataset.mode = pendingMode;
  el.setupTitle.textContent = t("name_" + pendingMode);
  el.setupLogo.textContent = MODE_LOGO[pendingMode] || "🥊";
  const visible = {
    free: ["fieldRoundLen", "fieldRoundCount", "fieldLevel", "fieldSensitivity", "fieldCount", "fieldStance", "fieldCamera"],
    sequence: ["fieldRoundLen", "fieldRoundCount", "fieldLevel", "fieldSensitivity", "fieldStance", "fieldCamera"],
    dodge: ["fieldRoundLen", "fieldRoundCount", "fieldLevel", "fieldStance", "fieldCamera"],
    progress: ["fieldRoundLen", "fieldRoundCount", "fieldLevel", "fieldSensitivity", "fieldCount", "fieldStance", "fieldCamera"],
  }[pendingMode] || [];
  for (const id of ["fieldRoundLen", "fieldRoundCount", "fieldRest", "fieldLevel", "fieldSpeed", "fieldSensitivity", "fieldCount", "fieldStance", "fieldCamera"]) {
    const field = $(id);
    if (field) field.hidden = !visible.includes(id);
  }
  document.querySelectorAll("#setupScreen .setup-group").forEach((group) => {
    const fields = [...group.querySelectorAll(".field")];
    group.hidden = fields.length > 0 && !fields.some((field) => !field.hidden);
  });
  if (el.progressHint) el.progressHint.hidden = pendingMode !== "progress";
}
function openSetup(m) {
  pendingMode = m;
  setSetupMode();
  setHomeMsg("");
  showScreen("setup");
}

// ---------- دورة الجلسة ----------
async function startSession() {
  if (state !== "home") return;
  setHomeMsg("");
  const oldLabel = el.btnStart.textContent;
  el.btnStart.disabled = true;
  el.btnStart.textContent = t("btn_preparing");
  try {
    readSettings();
    savePrefs();
    getAudio();                 // تفعيل الصوت ضمن نقرة المستخدم
    await ensureLandmarker();
    await openCamera();
    resetSession();
    setStatsHidden(true);
    showScreen("train");
    setState("calib");
    resizeCanvas();
    startLoop();
  } catch (err) {
    console.error(err);
    stopCamera();
    setHomeMsg(describeError(err), true);
  } finally {
    el.btnStart.disabled = false;
    el.btnStart.textContent = oldLabel;
  }
}

function resetSession() {
  stats = freshStats();
  activeMs = 0;
  roundMs = 0;
  restMs = 0;
  currentRound = 1;
  floaters = [];
  resetHands();
  targets = [];
  pillars = [];
  flashRed = 0;
  lastPose = null;
  calibReady = false;
  stableSince = 0;
  countdownMs = -1;
  seq = [];
  seqIdx = 0;
}

function setState(s) {
  state = s;
  el.calibOverlay.hidden = s !== "calib";
  el.restOverlay.hidden = s !== "rest";
  el.pauseOverlay.hidden = s !== "paused";
  if (s === "rest") {
    el.restNext.textContent = t("rest_next", { n: currentRound });
  }
  updateHud();
}

function startRound() {
  const baseSpeedMul = LEVEL_MUL[sessionLevel] ?? 1;
  speedMul = baseSpeedMul * (mode === "progress" ? Math.max(0.65, 1 - (currentRound - 1) * 0.12) : 1);
  roundMs = 0;
  resetHands();
  targets = [];
  pillars = [];
  seq = [];
  seqIdx = 0;
  nextTargetAt = activeMs + 500;
  nextPillarAt = activeMs + (mode === "dodge" ? 2000 : 4000);
  tone(660, 0.2, 0.2);
  setState("round");
}

function endRound() {
  tone(880, 0.35, 0.25);
  targets = [];
  pillars = [];
  stats.roundsDone++;
  if (currentRound >= totalRounds) {
    finishSession();
    return;
  }
  currentRound++;
  if (restDurMs > 0) {
    restMs = restDurMs;
    setState("rest");
  } else {
    startRound();
  }
}

function togglePause() {
  if (state === "round") setState("paused");
  else if (state === "paused") setState("round");
}

function finishSession() {
  if (state === "done") return;
  const minutes = activeMs / 60000;
  const sess = {
    date: new Date().toISOString(),
    mode,
    durationSec: Math.round(activeMs / 1000),
    roundsDone: stats.roundsDone,
    stance,
    total: stats.total,
    left: stats.left,
    right: stats.right,
    jab: stats.jab,
    cross: stats.cross,
    hits: stats.hits,
    targetHits: stats.targetHits,
    targetMiss: stats.targetMiss,
    wrongHand: stats.wrongHand,
    dodges: stats.dodges,
    pillarHits: stats.pillarHits,
    ppm: activeMs >= 5000 ? Math.round(stats.total / minutes) : 0,
    punchHit: stats.punchHit,
    punchMiss: stats.punchMiss,
    missJab: stats.missJab,
    missCross: stats.missCross,
    hitJab: stats.hitJab,
    hitCross: stats.hitCross,
    accuracy: stats.punchHit + stats.punchMiss
      ? Math.round((100 * stats.punchHit) / (stats.punchHit + stats.punchMiss)) : null,
    avgHitMs: stats.reactN ? Math.round(stats.reactSum / stats.reactN) : null,
    poseSamples: stats.poseSamples,
    lowGuardRate: stats.poseSamples ? Math.round((100 * stats.lowGuardSamples) / (2 * stats.poseSamples)) : null,
    leanRate: stats.poseSamples ? Math.round((100 * stats.leanSamples) / stats.poseSamples) : null,
  };
  if (stats.total > 0 || activeMs > 5000) saveSession(sess);

  cancelAnimationFrame(rafId);
  stopCamera();
  setState("done");
  showResult(sess);
}

function exitTraining(target = "trainMenu") {
  cancelAnimationFrame(rafId);
  stopCamera();
  state = "home";
  floaters = [];
  targets = [];
  pillars = [];
  el.calibOverlay.hidden = true;
  el.restOverlay.hidden = true;
  el.pauseOverlay.hidden = true;
  el.resultOverlay.hidden = true;
  showScreen(target);
}

// ---------- حلقة الرسم والكشف ----------
function startLoop() {
  cancelAnimationFrame(rafId);
  lastTs = performance.now();
  rafId = requestAnimationFrame(loop);
}

function loop(now) {
  rafId = requestAnimationFrame(loop);
  const dt = Math.min(100, now - lastTs);
  lastTs = now;

  const v = el.cam;
  if (v.readyState >= 2 && v.videoWidth) {
    vw = v.videoWidth;
    vh = v.videoHeight;
    updateLayout();
    // نعتمد على طابع الوقت لكل إطار، لأن currentTime لا يتغير دائمًا في بث الكاميرا
    if (landmarker && now > lastDetectTs) {
      lastDetectTs = now;
      detect(now);
    }
  }

  updateState(dt);
  render(now);
}

function updateState(dt) {
  flashRed = Math.max(0, flashRed - dt / 400);
  if (state === "calib" && countdownMs >= 0) {
    countdownMs += dt;
    if (countdownMs >= 3000) {
      countdownMs = -1;
      startRound();
      return;
    }
    setText(el.calibStatus, t("countdown", { n: 3 - Math.floor(countdownMs / 1000) }));
  }
  if (state === "round") {
    roundMs += dt;
    activeMs += dt;
    updateGame(dt);
    if (roundMs >= roundDurMs) endRound();
  } else if (state === "rest") {
    restMs -= dt;
    if (restMs <= 0) startRound();
  }
  updateHud();
}

// ---------- الكشف عن الجسم وتحليل اللكمات ----------
function smoothPose(points) {
  // تنعيم خفيف: يهدئ اهتزاز الجذع دون أن يجعل الهيكل يتأخر عن الحركة.
  if (!smoothedPose || smoothedPose.length !== points.length) {
    smoothedPose = points.map((p) => p ? { ...p } : p);
    return smoothedPose;
  }

  const previous = smoothedPose;
  const torso = new Set([11, 12, 23, 24]);
  const upperArms = new Set([13, 14]);
  const wristsAndHands = new Set([15, 16, 17, 18, 19, 20, 21, 22]);
  smoothedPose = points.map((p, i) => {
    const prev = previous[i];
    if (!p) return prev ? { ...prev, visibility: 0 } : p;
    if (!prev) return { ...p };

    const vis = p.visibility ?? 1;
    if (vis < 0.25) return { ...prev, visibility: vis };

    // Alpha أعلى = استجابة أسرع. الأيدي أسرع من الجذع حتى لا تتأخر اللكمات.
    const alpha = torso.has(i) ? 0.46
      : upperArms.has(i) ? 0.68
      : wristsAndHands.has(i) ? 0.88
      : 0.52;

    // نسمح بحركة أكبر لكل إطار، خصوصًا المعصمين، مع إبقاء حدّ بسيط للقفزات الشاذة.
    const maxStep = torso.has(i) ? 0.060
      : upperArms.has(i) ? 0.105
      : wristsAndHands.has(i) ? 0.240
      : 0.075;
    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    const distance = Math.hypot(dx, dy);
    const factor = distance > maxStep ? maxStep / distance : 1;
    const targetX = prev.x + dx * factor;
    const targetY = prev.y + dy * factor;

    return {
      ...p,
      x: prev.x + (targetX - prev.x) * alpha,
      y: prev.y + (targetY - prev.y) * alpha,
      z: (prev.z ?? 0) + ((p.z ?? 0) - (prev.z ?? 0)) * alpha,
    };
  });
  return smoothedPose;
}
function sampleCoachPose(lm, now) {
  // Sample at a low rate to avoid counting many nearly identical video frames.
  if (state !== "round" || now - lastCoachSampleAt < 650) return;
  lastCoachSampleAt = now;
  const ls = lm[11], rs = lm[12], lw = lm[15], rw = lm[16], lh = lm[23], rh = lm[24];
  const visible = (p) => !!p && (p.visibility ?? 1) >= 0.55;
  if (![ls, rs, lw, rw, lh, rh].every(visible) || poseSW < 2) return;

  stats.poseSamples++;
  const shoulderWidth = Math.max(0.001, Math.hypot(ls.x - rs.x, ls.y - rs.y));
  let lowHands = 0;
  // Ignore extended arms so the punch itself isn't treated as a dropped guard.
  const leftExt = Math.hypot(lw.x - ls.x, lw.y - ls.y) / shoulderWidth;
  const rightExt = Math.hypot(rw.x - rs.x, rw.y - rs.y) / shoulderWidth;
  if (leftExt < CFG.EXT_OFF && lw.y > ls.y + 0.10) lowHands++;
  if (rightExt < CFG.EXT_OFF && rw.y > rs.y + 0.10) lowHands++;
  stats.lowGuardSamples += lowHands;

  const shoulderMidX = (ls.x + rs.x) / 2;
  const hipMidX = (lh.x + rh.x) / 2;
  if (Math.abs(shoulderMidX - hipMidX) / shoulderWidth > 0.38) stats.leanSamples++;
}

function detect(now) {
  let res;
  try {
    res = landmarker.detectForVideo(el.cam, now);
  } catch (e) {
    console.warn(e);
    return;
  }
  const rawLm = res?.landmarks?.[0];
  if (!rawLm || rawLm.length < 17) {
    lastPose = null;
    smoothedPose = null;
    poseSW = 0;
    dropHandTracking();
    updateCalibration(null, 0, now);
    return;
  }
  const lm = smoothPose(rawLm);
  lastPose = lm;
  sampleCoachPose(lm, now);
  const L = lm[11], R = lm[12];
  poseSW = Math.hypot((L.x - R.x) * vw, (L.y - R.y) * vh);
  updateCalibration(lm, poseSW, now);

  const canCount = state === "round" && mode !== "dodge";
  processHand("left", lm, now, canCount);
  processHand("right", lm, now, canCount);
}

/*
  منطق اللكمة لكل ذراع:
  1) ext  : امتداد الذراع = المسافة (كتف→معصم) / عرض الكتف
  2) zF   : تقدّم المعصم نحو الكاميرا = (عمق الكتف - عمق المعصم) / عرض الكتف
  3) speed: سرعة المعصم خلال آخر WINDOW_MS (بوحدة عرض كتف/ثانية)
  - الذراع "مسلّحة" بعد أن تعود للاسترخاء، وتُقفل بعد كل لكمة (يمنع العدّ المزدوج)
*/
function processHand(side, lm, now, canCount) {
  const H = hands[side];
  const iS = side === "left" ? 11 : 12;
  const iW = side === "left" ? 15 : 16;
  const S = lm[iS], W = lm[iW];
  // نقطة القبضة (مفصل السبابة) هي التي تلمس القفاز، لا المعصم الذي يكون خلفها
  const K = lm[side === "left" ? 19 : 20];
  const TH = lm[side === "left" ? 21 : 22];
  const thumbVisible = TH && (TH.visibility ?? 1) >= CFG.VIS_MIN;
  // تقدير مركز القبضة من نقاط Pose المتاحة؛ هذا ليس بديلًا عن تتبع مفاصل اليد الكامل.
  const fist = K && (K.visibility ?? 1) >= CFG.VIS_MIN
    ? {
        x: thumbVisible ? K.x * 0.62 + W.x * 0.28 + TH.x * 0.10 : K.x * 0.69 + W.x * 0.31,
        y: thumbVisible ? K.y * 0.62 + W.y * 0.28 + TH.y * 0.10 : K.y * 0.69 + W.y * 0.31,
      }
    : W;
  const hitsBefore = stats.targetHits;

  if (!S || !W ||
      (S.visibility ?? 1) < CFG.VIS_MIN ||
      (W.visibility ?? 1) < CFG.VIS_MIN ||
      poseSW < 2) {
    H.armed = true;
    H.hist = [];
    return;
  }

  const sw = poseSW;
  const wx = W.x * vw, wy = W.y * vh;
  const ext = Math.hypot(wx - S.x * vw, wy - S.y * vh) / sw;
  const zF = ((S.z - W.z) * vw) / sw;

  H.hist.push({ t: now, x: wx, y: wy, zF, ext });
  while (H.hist.length > 1 && now - H.hist[0].t > CFG.WINDOW_MS) H.hist.shift();

  const o = H.hist[0];
  const prev = H.hist[H.hist.length - 2];   // الإطار السابق مباشرة لتحديد اتجاه الحركة الآن
  const dt = (now - o.t) / 1000;
  let speed = 0;
  if (dt > 0.03) {
    speed = Math.hypot(wx - o.x, wy - o.y, (zF - o.zF) * sw) / sw / dt;
  }

  // بعد الضربة نتابع المعصم نصف ثانية، فإن لامس قفازًا مقتربًا تُحتسب الإصابة
  if (canCount && now < H.contactUntil) {
    const sp = toScreen(fist.x, fist.y);
    if (tryTargetHit(side, sp)) H.contactUntil = 0;
  }

  const extended = ext > extOnNow || zF > CFG.Z_ON;
  const retracted = ext < CFG.EXT_OFF && zF < CFG.Z_OFF;
  if (retracted || now - H.lastJudge > CFG.REARM_MS) H.armed = true;

  if (canCount && mode === "sequence") {
    // في التسلسل: أي لمسة للقفاز بذراع ممدودة تُحتسب مرة واحدة لكل هدف (judged يمنع التكرار)
    // نُبقي حدًا أدنى للسرعة حتى لا تُحتسب اليد الثابتة التي تمر فوق القفاز
    if (extended && speed >= speedMinNow * 0.5 && judgeSequenceHit(side, fist.x, fist.y)) H.lastJudge = now;
  } else if (canCount && countTargetsOnly) {
    // الحرّ مع احتساب الأهداف فقط: لا تُحتسب اللكمة إلا إذا وصلت إلى هدف حي
    if (extended && H.armed && speed >= speedMinNow * 0.8 && judgeTargetPunch(side, fist.x, fist.y)) { H.armed = false; H.lastJudge = now; }
  } else if (canCount && extended && speed >= speedMinNow) {
    if (H.armed && now - H.lastPunch >= CFG.COOLDOWN_MS) {
      H.armed = false;
      H.lastPunch = now;
      H.lastJudge = now;
      registerPunch(side, fist.x, fist.y, now);
    }
  }

  // ---- دقة اللكمات ----
  // كل امتداد سريع للذراع = لكمة واحدة. إن لمست القفاز فهي إصابة، وإن انتهت دون لمس
  // والقفاز كان حيًا فهي خطأ مرة واحدة. تحريك اليد البطيء لا يُحسب شيئًا.
  const hitNow = stats.targetHits > hitsBefore;
  const leadSide = stance === "orthodox" ? "left" : "right";
  if (hitNow) {
    stats.punchHit += stats.targetHits - hitsBefore;
    if (side === leadSide) stats.hitJab++; else stats.hitCross++;
  }
  const E = H.ep;
  if (canCount && mode !== "dodge") {
    if (E.active) {
      if (hitNow) E.hit = true;
      if (targets.some((tg) => tg.state === "live")) E.targeted = true;
      if (retracted || now - E.start > 900) {
        if (!E.hit && E.targeted) {
          stats.punchMiss++;
          if (E.type === "jab") stats.missJab++; else stats.missCross++;
        }
        H.ep = freshEpisode();
      }
    } else if (extended && speed >= speedMinNow * 0.8 && prev && (zF > prev.zF || ext > prev.ext)) {
      // اللكمة حركة للأمام فقط: الذراع تمتد أو تتجه نحو الكاميرا، لا تراجع السحب
      const lead = stance === "orthodox" ? "left" : "right";
      H.ep = { active: true, start: now, hit: hitNow,
               targeted: targets.some((tg) => tg.state === "live"),
               type: side === lead ? "jab" : "cross" };
    }
  }
}

function handName(side) {
  return side === "left" ? t("hand_left") : t("hand_right");
}

function registerPunch(side, nx, ny, now) {
  // اليد الأمامية = الجاب، والخلفية = الكروس
  const lead = stance === "orthodox" ? "left" : "right";
  const type = side === lead ? "jab" : "cross";
  const p = toScreen(nx, ny);

  stats.total++;
  stats[side]++;
  stats[type]++;
  addFloater(`${handName(side)} · ${type === "jab" ? t("kind_jab") : t("kind_cross")}`, p.x, p.y, "#ffffff", "punch");

  // نافذة تتبع قصيرة بعد الضربة (انظر processHand)
  hands[side].contactUntil = now + 500;
  if (!tryTargetHit(side, p)) tone(220, 0.07, 0.12, "square");
  updateHud();
}

// يولّد تسلسلًا عشوائيًا: كل خطوة لها نوع ضربة ويد ومكان وسرعة
function newSequence() {
  const lead = stance === "orthodox" ? "left" : "right";
  const rear = lead === "left" ? "right" : "left";
  seq = [];
  for (let i = 0; i < SEQ_LEN; i++) {
    const kind = Math.random() < 0.5 ? "jab" : "cross";
    seq.push({
      kind,
      hand: kind === "jab" ? lead : rear,
      lane: pickLane(),
      high: Math.random() < 0.5,
      ms: Math.round(SEQ_BASE_MS * speedMul),
    });
  }
  seqIdx = 0;
}

function advanceSeq() {
  seqIdx++;
  if (seqIdx >= seq.length) {
    stats.seqDone++;
    seq = [];
    seqIdx = 0;
  }
}

// يحاول احتساب الضربة على الهدف؛ يعيد true إن كانت الضربة قد استُهلكت على هدف
function tryTargetHit(side, p) {
  const tgt = findTargetAt(p.x, p.y);
  // لا نعتبر اللمسة إصابة إذا كان الهدف قد حُسم أو لم يعد حيًا.
  if (!tgt || tgt.state !== "live" || tgt.judged) return false;
  if (tgt.seqMode && tgt.hand !== side) {
    stats.wrongHand++;
    addFloater(t("fl_wrong"), p.x, p.y - 36, "#ff5a64");
    tone(180, 0.12, 0.15, "square");
    return true;
  }
  applyTargetHit(tgt, p);
  return true;
}

// كل هدف يُحكم عليه مرة واحدة: اليد الصحيحة تحتسب إصابة، واليد الخاطئة تُسجَّل خطأً مرة واحدة فقط
function judgeSequenceHit(side, nx, ny) {
  const p = toScreen(nx, ny);
  const tgt = findTargetAt(p.x, p.y);
  if (!tgt || tgt.judged) return false;
  if (tgt.hand === side) {
    tgt.judged = true;
    stats.total++;
    stats[side]++;
    stats[tgt.kind]++;
    addFloater(`${handName(side)} · ${tgt.kind === "jab" ? t("kind_jab") : t("kind_cross")}`, p.x, p.y, "#ffffff", "punch");
    applyTargetHit(tgt, p);
    return true;
  }
  if (!tgt.wrongCounted) {
    tgt.wrongCounted = true;
    stats.wrongHand++;
    addFloater(t("fl_wrong"), p.x, p.y - 36, "#ff5a64");
    tone(180, 0.12, 0.15, "square");
    return true;
  }
  return false;
}

// الوضع الحر مع احتساب الأهداف فقط: تُحتسب اللكمة إذا لامست هدفًا حيًا
function judgeTargetPunch(side, nx, ny) {
  const p = toScreen(nx, ny);
  const tgt = findTargetAt(p.x, p.y);
  if (!tgt || tgt.state !== "live" || tgt.judged) return false;
  const lead = stance === "orthodox" ? "left" : "right";
  const type = side === lead ? "jab" : "cross";
  stats.total++;
  stats[side]++;
  stats[type]++;
  addFloater(`${handName(side)} · ${type === "jab" ? t("kind_jab") : t("kind_cross")}`, p.x, p.y, "#ffffff", "punch");
  applyTargetHit(tgt, p);
  return true;
}

function applyTargetHit(tgt, p) {
  if (!tgt || tgt.state !== "live") return false; // الحالة الحية هي الحارس النهائي لمنع تكرار العدّ
  tgt.judged = true;
  tgt.state = "hit";
  tgt.age = 0;
  stats.targetHits++;
  stats.reactSum += Math.max(0, activeMs - (tgt.born ?? activeMs));
  stats.reactN++;
  nextTargetAt = activeMs + TARGET_GAP_MS;
  if (tgt.seqMode) advanceSeq();
  addFloater(t("fl_target"), p.x, p.y - 36, "#ffd166");
  tone(520, 0.12, 0.2, "triangle");
  updateHud();
  return true;
}

// ---------- المعايرة ----------
function updateCalibration(lm, sw, now) {
  if (state !== "calib") return;
  let msg = t("calib_none");
  let ok = false;

  if (lm) {
    const ids = [11, 12, 13, 14, 15, 16];
    const visOk = ids.every((i) => (lm[i].visibility ?? 1) >= CFG.VIS_MIN);
    const inFrame = [11, 12, 15, 16].every(
      (i) => lm[i].x > 0.02 && lm[i].x < 0.98 && lm[i].y > 0.02 && lm[i].y < 0.98
    );
    const ratio = sw / (isRotated() ? vh : vw);
    if (!visOk || !inFrame) msg = t("calib_show");
    else if (ratio < CFG.SW_MIN) msg = t("calib_closer");
    else if (ratio > CFG.SW_MAX) msg = t("calib_back");
    else { ok = true; msg = t("calib_ok"); }
  }

  if (ok) {
    if (!stableSince) stableSince = now;
    calibReady = now - stableSince >= CFG.READY_HOLD_MS;
  } else {
    stableSince = 0;
    calibReady = false;
    countdownMs = -1;            // أي خلل في الوضعية يلغي العد التنازلي
  }
  if (calibReady && countdownMs < 0) countdownMs = 0;   // يبدأ العد تلقائيًا
  el.calibBtn.hidden = true;                             // لا حاجة لزر البدء
  if (countdownMs >= 0) return;                          // النص يُحدَّث من updateState
  setText(el.calibStatus, msg);
}

// ---------- تخطيط الفيديو (cover: تملأ الشاشة دون فراغات) ----------
function resizeCanvas() {
  const r = el.stage.getBoundingClientRect();
  cw = r.width;
  ch = r.height;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  el.stage.width = Math.round(cw * dpr);
  el.stage.height = Math.round(ch * dpr);
  updateLayout();
}

function isRotated() {
  return rot % 2 === 1;
}

let autoRotKey = "";
function updateLayout() {
  if (!vw || !vh || !cw || !ch) return;
  // التدوير التلقائي يُحسب عند تغيّر أبعاد الفيديو أو الشاشة فقط، لا في كل إطار
  if (rotAuto) {
    const key = `${vw}x${vh}|${cw}x${ch}`;
    if (key !== autoRotKey) {
      autoRotKey = key;
      rot = (vw > vh) !== (cw > ch) ? 1 : 0;
      videoKey = "";
    }
  }
  dw = isRotated() ? vh : vw;
  dh = isRotated() ? vw : vh;
  scale = Math.max(cw / dw, ch / dh);   // cover: تملأ الشاشة دون فراغات
  offX = 0;
  offY = 0;
}

// يرسم بث الكاميرا على الـ canvas بنفس التحويل الذي تُحسب به النقاط (تدوير + مرآة)
function drawCamera() {
  if (!vw || !vh || el.cam.readyState < 2) return;
  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  if (mirror) ctx.scale(-1, 1);
  ctx.rotate((rot * Math.PI) / 2);
  ctx.scale(scale, scale);
  ctx.drawImage(el.cam, -vw / 2, -vh / 2, vw, vh);
  ctx.restore();
}

// يحوّل إحداثيات الفيديو الأصلية (0..1) إلى إحداثيات الشاشة، مع التدوير والمرآة
function toScreen(nx, ny) {
  const u = (nx - 0.5) * vw * scale;
  const v = (ny - 0.5) * vh * scale;
  const a = (rot * Math.PI) / 2;
  const c = Math.cos(a), s = Math.sin(a);
  let x = u * c - v * s;
  const y = u * s + v * c;
  if (mirror) x = -x;
  return { x: cw / 2 + x, y: ch / 2 + y };
}

// ---------- القفاز المقترب (الهدف) ----------
// t.k من 0 (بعيد، في المنتصف عند الأفق) إلى 1 (قريب منك)
function targetPos(t) {
  const y = t.high === undefined ? ch * (0.2 + 0.3 * t.k) : ch * ((t.high ? 0.14 : 0.3) + 0.25 * t.k);
  return { x: cw / 2 + t.lane * cw * 0.3 * t.k, y };
}
function targetRadius(t) {
  // تكبير معتدل يجعل القفاز أوضح وأسهل للمس على شاشة الهاتف.
  return Math.min(cw, ch) * (0.040 + 0.145 * Math.pow(t.k, 1.3));
}
function findTargetAt(x, y) {
  for (const t of targets) {
    if (t.state !== "live" || t.k < 0.12) continue;
    const p = targetPos(t);
    if (Math.hypot(x - p.x, y - p.y) <= targetRadius(t) * 1.3) return t;
  }
  return null;
}

function updateGame(dt) {
  // تحديث الأهداف
  for (const t of targets) {
    if (t.state === "live") {
      t.k += dt / (t.ms || TARGET_MS * speedMul);
      if (t.k >= 1) {
        t.state = "miss";
        t.age = 0;
        stats.targetMiss++;
        nextTargetAt = activeMs + TARGET_GAP_MS;
        if (t.seqMode) advanceSeq();
      }
    } else {
      t.age += dt;
    }
  }
  targets = targets.filter((t) => t.state === "live" || t.age < 400);
  // لا يظهر قفاز خلف حاجز قريب، ولا يظهر حاجز والقفاز ما زال مقتربًا
  if (mode !== "dodge" && !targets.some((t) => t.state === "live") && activeMs >= nextTargetAt &&
      !pillars.some((p) => p.k > 0.45)) {
    if (mode === "sequence") {
      if (!seq.length) newSequence();
      const st = seq[seqIdx];
      targets.push({ state: "live", lane: st.lane, high: st.high, ms: st.ms, hand: st.hand, kind: st.kind, seqMode: true, judged: false, wrongCounted: false, k: 0, age: 0, born: activeMs });
    } else {
      targets.push({ state: "live", lane: pickTargetLane(), ms: Math.round(TARGET_MS * speedMul), k: 0, age: 0, born: activeMs });
    }
  }

  // تحديث الحواجز
  const pillarMs = PILLAR_MS * speedMul;
  for (const p of pillars) {
    p.k += dt / pillarMs;
    if (!p.judged && p.k >= PILLAR_JUDGE_K) judgePillar(p);
  }
  const hadPillars = pillars.length > 0;
  pillars = pillars.filter((p) => p.k < 1.1);
  // حاجز واحد في كل مرة: التالي يبدأ بعد مرور الحالي، والفاصل يتبع سرعة الجلسة المختارة
  if (hadPillars && pillars.length === 0) {
    const gap = mode === "dodge"
      ? DODGE_GAP_MIN + Math.random() * DODGE_GAP_RAND
      : PILLAR_GAP_MIN + Math.random() * PILLAR_GAP_RAND;
    nextPillarAt = activeMs + gap * speedMul;
  }
  if (pillars.length === 0 && activeMs >= nextPillarAt && !targets.some((t) => t.state === "live")) {
    pillars.push({ lane: pickLane(), high: pickPillarHeight(), k: 0, judged: false });
  }
}

// ---------- الحواجز ----------
// كل حاجز يتجه إما إلى الرأس أو إلى الجسم، بالتناوب
function pickPillarHeight() {
  const high = lastPillarHigh === null ? Math.random() < 0.5 : !lastPillarHigh;
  lastPillarHigh = high;
  return high;
}
function pillarX(p) {
  return cw / 2 + p.lane * cw * 0.3 * p.k;
}
function pillarW(p) {
  return cw * (0.04 + 0.12 * p.k);
}
function bodyCenterX() {
  const L = lastPose[11], R = lastPose[12];
  return toScreen((L.x + R.x) / 2, (L.y + R.y) / 2).x;
}
function headCenterX() {
  const n = lastPose && lastPose[0];                 // الأنف = مركز الرأس
  if (n && (n.visibility ?? 1) > CFG.VIS_MIN) return toScreen(n.x, n.y).x;
  return bodyCenterX();
}
function bodyHalfWidth() {
  return Math.max(poseSW * scale * 0.6, 30);
}

// الحكم على الحاجز: هل كان جسمك داخل مساره لحظة وصوله؟
function judgePillar(p) {
  p.judged = true;
  if (!lastPose || !poseSW) return;          // لا حكم بدون رؤية الجسم
  const bx = p.high ? headCenterX() : bodyCenterX();   // الحاجز للرأس يُحكم على الرأس، والآخر على الجسم
  const px = pillarX(p);
  const reach = pillarW(p) / 2 + bodyHalfWidth();
  const y = p.high ? ch * 0.22 : ch * 0.55;
  if (Math.abs(bx - px) < reach) {
    stats.pillarHits++;
    flashRed = 1;
    addFloater(t("fl_hit"), bx, y, "#ff5a64");
    tone(120, 0.25, 0.25, "sawtooth");
  } else {
    stats.dodges++;
    addFloater(t("fl_dodge"), bx, y, "#7CFC9A");
    tone(880, 0.12, 0.15, "triangle");
  }
  updateHud();
}

// الحواجز: شرائح مائلة تتجه نحو الرأس
function drawPillars() {
  for (const p of pillars) {
    if (p.k < 0.02) continue;
    const x = pillarX(p), w = pillarW(p);
    const h = ch * (0.12 + 0.3 * p.k);
    const cy = p.high ? ch * 0.22 : ch * 0.55;   // مستوى الرأس أو الجسم
    const a = Math.min(1, 0.3 + p.k);
    const edge = p.high ? "225,29,46" : "255,190,60"; // أحمر للرأس، ذهبي للجسم
    ctx.save();
    ctx.translate(x, cy);
    ctx.rotate(-p.lane * 0.35);          // ميلان يتجه نحو منتصف الشاشة (الرأس)
    const grad = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    grad.addColorStop(0, `rgba(40,40,48,${a})`);
    grad.addColorStop(0.5, `rgba(125,130,142,${a})`);
    grad.addColorStop(1, `rgba(40,40,48,${a})`);
    ctx.fillStyle = grad;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = `rgba(${edge},${a})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
}

// رسم قفاز: كفّ مع إبهام ومعصم أبيض
function drawGlove(x, y, r, alpha, color) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;

  ctx.fillStyle = "#e9e9e9";
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x - r * 0.55, y + r * 0.55, r * 1.1, r * 0.5, r * 0.15)
                : ctx.rect(x - r * 0.55, y + r * 0.55, r * 1.1, r * 0.5);
  ctx.fill();

  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  g.addColorStop(0, "#ff5a64");
  g.addColorStop(1, color);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.75, r * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(x - r * 0.65, y + r * 0.1, r * 0.28, r * 0.42, -0.3, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = Math.max(1, r * 0.04);
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(x - r * 0.45, y + i * r * 0.25 - r * 0.1);
    ctx.lineTo(x + r * 0.4, y + i * r * 0.25 - r * 0.1);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.beginPath();
  ctx.ellipse(x + r * 0.2, y - r * 0.35, r * 0.22, r * 0.12, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawTargets() {
  for (const t of targets) {
    const p = targetPos(t);
    const r = targetRadius(t);
    if (t.state === "live") {
      drawGlove(p.x, p.y, r, 1, "#8e0f1a");
    } else {
      const a = Math.max(0, 1 - t.age / 400);
      if (t.state === "hit") {
        ctx.save();
        ctx.globalAlpha = a;
        ctx.strokeStyle = "#ffd166";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * (2 - a), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        drawGlove(p.x, p.y, r, a, "#ff2d3d");
      } else {
        drawGlove(p.x, p.y, r, a * 0.6, "#555");
      }
    }
  }
}

// ---------- الرسم ----------
const PAIRS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [15, 17], [15, 19], [15, 21], [16, 18], [16, 20], [16, 22],
];

function render(now) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  drawCamera();

  if (state === "round" || state === "paused" || state === "rest") {
    drawPillars();
    drawTargets();
  }

  if (lastPose) drawSkeleton(now);
  drawFloaters(now);

  if (flashRed > 0) {
    ctx.fillStyle = `rgba(255,0,0,${flashRed * 0.3})`;
    ctx.fillRect(0, 0, cw, ch);
  }
}

function drawSkeleton(now) {
  const lm = lastPose;
  const good = (i) => lm[i] && (lm[i].visibility ?? 1) > 0.3;

  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2.5, Math.min(4, Math.min(cw, ch) * 0.006));
  ctx.strokeStyle = "rgba(255,255,255,0.82)";
  for (const [a, b] of PAIRS) {
    if (!good(a) || !good(b)) continue;
    const p = toScreen(lm[a].x, lm[a].y);
    const q = toScreen(lm[b].x, lm[b].y);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if (!good(i)) continue;
    const p = toScreen(lm[i].x, lm[i].y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
  }

  // مؤشر القبضة تقريبي لأن نموذج Pose لا يرى مفاصل اليد الدقيقة.
  // نمزج السبابة والإبهام مع المعصم بدل وضع المؤشر عند أسفل اليد.
  const r = Math.max(12, poseSW * scale * 0.105);
  for (const side of ["left", "right"]) {
    const wristIdx = side === "left" ? 15 : 16;
    const indexIdx = side === "left" ? 19 : 20;
    const thumbIdx = side === "left" ? 21 : 22;
    if (!good(wristIdx)) continue;
    const wrist = lm[wristIdx];
    const index = good(indexIdx) ? lm[indexIdx] : wrist;
    const thumb = good(thumbIdx) ? lm[thumbIdx] : index;
    const fx = index.x * 0.55 + thumb.x * 0.15 + wrist.x * 0.30;
    const fy = index.y * 0.55 + thumb.y * 0.15 + wrist.y * 0.30;
    const p = toScreen(fx, fy);
    const recent = now - hands[side].lastPunch < 260;
    ctx.beginPath();
    ctx.arc(p.x, p.y, recent ? r * 1.25 : r, 0, Math.PI * 2);
    ctx.fillStyle = recent ? "#ff2d3d" : "rgba(225,29,46,0.85)";
    ctx.shadowColor = "#ff2d3d";
    ctx.shadowBlur = recent ? 25 : 8;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawFloaters(now) {
  const LIFE = 900;
  floaters = floaters.filter((f) => now - f.born < LIFE);
  ctx.font = "700 16px system-ui, sans-serif";
  ctx.textAlign = "center";
  for (const f of floaters) {
    if (f.kind === "punch" && !labelsOn) continue;   // توضيح نوع اللكمة اختياري
    const age = (now - f.born) / LIFE;
    ctx.globalAlpha = 1 - age;
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y - age * 40);
  }
  ctx.globalAlpha = 1;
}

// ---------- لوحة المعلومات (HUD) ----------
function updateHud() {
  const ppm = activeMs >= 5000 ? Math.round(stats.total / (activeMs / 60000)) : 0;
  setText(el.total, stats.total);
  setText(el.leftCount, stats.left);
  setText(el.rightCount, stats.right);
  setText(el.jabCount, stats.jab);
  setText(el.crossCount, stats.cross);
  setText(el.ppm, ppm);

  if (mode === "sequence" && state !== "home" && labelsOn) {
    el.seqPrompt.hidden = false;
    if (seq.length && seqIdx < seq.length) {
      const st = seq[seqIdx];
      const zone = `${t(st.high ? "pos_high" : "pos_low")} ${t(st.lane < 0 ? "pos_left" : st.lane > 0 ? "pos_right" : "pos_center")}`;
      const speed = t("speed_" + sessionSpeed);
      setText(el.seqPrompt, t("seq_line", {
        i: seqIdx + 1, n: seq.length,
        kind: st.kind === "jab" ? t("kind_jab") : t("kind_cross"),
        hand: handName(st.hand),
        zone, speed,
      }));
    } else {
      setText(el.seqPrompt, t("seq_prep"));
    }
  } else {
    el.seqPrompt.hidden = true;
  }
  setText(el.targetHits, stats.targetHits);
  setText(el.dodges, stats.dodges);
  setText(el.pillarHits, stats.pillarHits);

  let remain;
  if (state === "rest") remain = restMs;
  else if (state === "calib" || state === "home") remain = roundDurMs;
  else remain = roundDurMs - roundMs;
  setText(el.timer, fmtTime(remain));

  setText(el.roundLabel, t("round_label", { n: currentRound, m: totalRounds }));
  setText(el.statusPill, STATUS_KEYS[state] ? t(STATUS_KEYS[state]) : "");
  setText(el.restCount, Math.ceil(Math.max(0, restMs) / 1000));
  el.btnPause.textContent = state === "paused" ? "▶" : "⏸";
  el.btnRotate.textContent = `${t("btn_rotate").split(" ")[0]} ${rot * 90}°`;
  el.btnStance.textContent = stance === "orthodox" ? t("ctrl_left") : t("ctrl_right");
}

function setStatsHidden(v) {
  statsHidden = v;
  document.body.classList.toggle("hide-stats", v);
  el.btnStats.textContent = t(v ? "btn_show_stats" : "btn_hide_stats");
}
function setLabels(v) {
  labelsOn = v;
  el.btnLabels.textContent = t(v ? "lbl_hide" : "lbl_show");
}

// ---------- النتيجة ----------
function breakdownRows(rows) {
  const max = Math.max(1, ...rows.map((r) => r.hit + r.miss));
  return rows.map((r) => `
      <div class="pbar-row">
        <div class="pbar-label">${r.label}</div>
        <div class="pbar-track">
          <div class="pbar-hit" style="width:${(100 * r.hit) / max}%"></div>
          <div class="pbar-miss" style="width:${(100 * r.miss) / max}%"></div>
        </div>
        <div class="pbar-val">${r.hit + r.miss}</div>
      </div>`).join("");
}
function legendHTML() {
  return `<div class="pbar-legend"><span><span class="sw hit"></span>${t("pb_legend_hit")}</span><span><span class="sw miss"></span>${t("pb_legend_miss")}</span></div>`;
}
function accuracyBlock(s) {
  const hasAcc = typeof s.accuracy === "number";
  const avg = s.avgHitMs ? (s.avgHitMs / 1000).toFixed(1) + " s" : "—";
  const rows = [
    { label: t("pb_jab"), hit: s.hitJab || 0, miss: s.missJab || 0 },
    { label: t("pb_cross"), hit: s.hitCross || 0, miss: s.missCross || 0 },
    { label: t("pb_dodge"), hit: s.dodges || 0, miss: s.pillarHits || 0 },
  ];
  return `
    <h3 class="section-title">${t("res_acc")}</h3>
    <div class="pbar-card">${breakdownRows(rows)}${legendHTML()}</div>
    <div class="res-grid">
      <div><b>${hasAcc ? s.accuracy + "%" : "—"}</b><small>${t("res_acc_pct")}</small></div>
      <div><b>${avg}</b><small>${t("res_avg_hit")}</small></div>
      <div><b>${s.roundsDone || 0}</b><small>${t("res_rounds")}</small></div>
    </div>`;
}

function poseFeedbackHTML(s) {
  if ((s.poseSamples || 0) < 8) {
    return '<p class="notice small">' + t("coach_pose_unavailable") + '</p>';
  }
  return '<h3 class="section-title">' + t("coach_pose_title") + '</h3>' +
    '<div class="res-grid">' +
      '<div><b>' + (typeof s.lowGuardRate === "number" ? s.lowGuardRate + "%" : "—") + '</b><small>' + t("coach_pose_guard") + '</small></div>' +
      '<div><b>' + (typeof s.leanRate === "number" ? s.leanRate + "%" : "—") + '</b><small>' + t("coach_pose_lean") + '</small></div>' +
    '</div>';
}

function showResult(s) {
  const note = s.total === 0 ? t("res_none") : "";
  el.resultBody.innerHTML = `
    <div class="res-grid">
      <div><b>${s.total}</b><small>${t("res_total")}</small></div>
      <div><b>${s.ppm}</b><small>${t("res_ppm")}</small></div>
      <div><b>${fmtTime(s.durationSec * 1000)}</b><small>${t("res_time")}</small></div>
      <div><b>${s.targetHits}</b><small>${t("res_targets")}</small></div>
      <div><b>${s.dodges}</b><small>${t("res_dodges")}</small></div>
      <div><b>${s.pillarHits}</b><small>${t("res_hits")}</small></div>
      ${s.mode === "sequence" ? `<div><b>${stats.seqDone}</b><small>${t("res_combos")}</small></div><div><b>${stats.wrongHand}</b><small>${t("res_wrong")}</small></div>` : ""}
      <div><b>${s.left}</b><small>${t("res_left")}</small></div>
      <div><b>${s.right}</b><small>${t("res_right")}</small></div>
      <div><b>${s.jab}</b><small>${t("res_jab")}</small></div>
      <div><b>${s.cross}</b><small>${t("res_cross")}</small></div>
    </div>
    ${accuracyBlock(s)}
    ${poseFeedbackHTML(s)}
    ${note ? `<p class="notice">${note}</p>` : ""}
    <p class="notice small">${t("res_note")}</p>`;
  el.resultOverlay.hidden = false;
}

// ---------- السجل المحلي ----------
function loadSessions() {
  try {
    const arr = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveSession(s) {
  try {
    const arr = loadSessions();
    arr.unshift(s);
    try { navigator.storage?.persist?.(); } catch {}   // يطلب من المتصفح عدم حذف البيانات تلقائيًا
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr.slice(0, 100)));
  } catch (e) {
    console.warn("تعذر حفظ الجلسة:", e);
  }
}

function renderHistory() {
  const arr = loadSessions();
  const totalPunches = arr.reduce((sum, x) => sum + (x.total || 0), 0);
  const totalSec = arr.reduce((sum, x) => sum + (x.durationSec || 0), 0);
  const bestPpm = arr.reduce((m, x) => Math.max(m, x.ppm || 0), 0);
  const bestAcc = arr.reduce((m, x) => Math.max(m, typeof x.accuracy === "number" ? x.accuracy : 0), 0);
  const roundsTotal = arr.reduce((sum, x) => sum + (x.roundsDone || 0), 0);

  let html = `
    <div class="res-grid">
      <div><b>${arr.length}</b><small>${t("hist_sessions")}</small></div>
      <div><b>${totalPunches}</b><small>${t("hist_punches")}</small></div>
      <div><b>${Math.round(totalSec / 60)}</b><small>${t("hist_minutes")}</small></div>
      <div><b>${bestPpm}</b><small>${t("hist_best")}</small></div>
      <div><b>${bestAcc ? bestAcc + "%" : "—"}</b><small>${t("prog_best_acc")}</small></div>
      <div><b>${roundsTotal}</b><small>${t("prog_rounds")}</small></div>
    </div>`;

  if (arr.length) {
    const { rows, overall } = typeRows(arr);
    html += `<h3 class="section-title">${t("pb_title")}</h3>
      <div class="pbar-card">${breakdownRows(rows)}${legendHTML()}</div>
      <p class="notice small">${t("pb_overall")}: ${overall}</p>`;
  }

  if (!arr.length) {
    html += `<p class="notice">${t("hist_empty")}</p>`;
  } else {
    html += arr.slice(0, 30).map((s) => `
      <div class="hist-item">
        <div>
          <b>${fmtDate(s.date)}</b>
          <small>${t("hist_line", { r: s.roundsDone, t: fmtTime((s.durationSec || 0) * 1000), s: s.stance === "orthodox" ? t("ctrl_left") : t("ctrl_right") })}</small>
        </div>
        <div class="hist-num">
          <b>${s.total}</b> ${t("unit_punch")}<br>
          <small>${t("hist_summary", { p: s.ppm, g: s.targetHits || 0, d: s.dodges || 0 })}${typeof s.accuracy === "number" ? " · " + t("hist_acc", { a: s.accuracy }) : ""}</small>
        </div>
      </div>`).join("");
  }
  el.historyBody.innerHTML = html;
}

// ---------- المدرّب الذكي: تحليل محلي لأرقام الجلسات (بدون API) ----------
function analyzeSessions(arr) {
  if (!arr.length) return null;
  const sum = (key) => arr.reduce((s, x) => s + (Number(x[key]) || 0), 0);
  const recent = arr.slice(0, 5);
  const avgPpm = Math.round(recent.reduce((s, x) => s + (x.ppm || 0), 0) / recent.length);
  const punches = sum("total");
  const crosses = sum("cross");
  const gloveAll = sum("targetHits") + sum("targetMiss");
  const glovePct = gloveAll ? Math.round((100 * sum("targetHits")) / gloveAll) : null;
  const dodged = sum("dodges");
  const hitBy = sum("pillarHits");
  const dodgePct = dodged + hitBy ? Math.round((100 * dodged) / (dodged + hitBy)) : null;
  const wrong = sum("wrongHand");

  const tips = [];
  if (avgPpm && avgPpm < 20) tips.push(t("coach_tip_speed"));
  if (dodgePct !== null && dodgePct < 50) tips.push(t("coach_tip_dodge"));
  if (punches >= 20 && crosses / punches < 0.25) tips.push(t("coach_tip_cross"));
  if (wrong >= 3) tips.push(t("coach_tip_sequence"));
  const poseSessions = recent.filter((x) => (x.poseSamples || 0) >= 8);
  if (poseSessions.length) {
    const guardRate = poseSessions.reduce((n, x) => n + (Number(x.lowGuardRate) || 0), 0) / poseSessions.length;
    const leanRate = poseSessions.reduce((n, x) => n + (Number(x.leanRate) || 0), 0) / poseSessions.length;
    if (guardRate >= 42) tips.push(t("coach_tip_guard"));
    if (leanRate >= 28) tips.push(t("coach_tip_balance"));
  }
  const accs = arr.filter((x) => typeof x.accuracy === "number").map((x) => x.accuracy);
  if (accs.length && accs.reduce((a, b) => a + b, 0) / accs.length < 50) tips.push(t("coach_tip_accuracy"));
  if (arr.length >= 2 && (arr[0].ppm || 0) > (arr[1].ppm || 0)) tips.push(t("coach_tip_improving"));
  if (!tips.length) tips.push(t("coach_tip_good"));
  return { sessions: arr.length, avgPpm, glovePct, dodgePct, tips };
}

// أرقام الأنواع (جاب/كروس/تفادٍ) تُعرض في سجل النشاط
function typeRows(arr) {
  const sum = (k) => arr.reduce((acc, x) => acc + (Number(x[k]) || 0), 0);
  const rows = [
    { label: t("pb_jab"), hit: sum("hitJab"), miss: sum("missJab") },
    { label: t("pb_cross"), hit: sum("hitCross"), miss: sum("missCross") },
    { label: t("pb_dodge"), hit: sum("dodges"), miss: sum("pillarHits") },
  ];
  const landed = rows[0].hit + rows[1].hit;
  const thrown = landed + rows[0].miss + rows[1].miss;
  const overall = thrown ? Math.round((100 * landed) / thrown) + "%" : "—";
  return { rows, overall };
}

function renderCoach() {
  // الإحصائيات تبقى في سجل النشاط فقط، ولا تُعرض في واجهة المدرب.
  el.coachBody.innerHTML = "";
  el.coachBody.hidden = true;
}

function clearHistory() {
  if (!confirm(t("hist_confirm"))) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  renderHistory();
}

// ---------- الأحداث ----------
document.querySelectorAll(".mode-card").forEach((card) => {
  card.addEventListener("click", () => openSetup(card.dataset.mode));
});
el.btnSetupBack.addEventListener("click", () => showScreen("trainMenu"));
el.btnStart.addEventListener("click", startSession);

el.btnSettings.addEventListener("click", () => (el.settingsModal.hidden = false));
el.btnCloseSettings.addEventListener("click", () => {
  savePrefs();
  el.settingsModal.hidden = true;
});
el.langSel.addEventListener("change", () => setLang(el.langSel.value));
el.themeSel.addEventListener("change", () => setTheme(el.themeSel.value));
el.soundToggle.addEventListener("change", savePrefs);
el.btnResetHistory.addEventListener("click", clearHistory);

el.btnHistory.addEventListener("click", () => {
  renderHistory();
  el.historyModal.hidden = false;
});
el.btnCloseHistory.addEventListener("click", () => (el.historyModal.hidden = true));
el.btnClearHistory.addEventListener("click", clearHistory);
el.btnHelp.addEventListener("click", () => (el.helpModal.hidden = false));
el.btnCloseHelp.addEventListener("click", () => (el.helpModal.hidden = true));
el.btnCoach.addEventListener("click", () => {
  window.location.href = "coach-preview.html?v=20261018b";
});

// ---------- المدرّب المحلي: إرشادات قواعدية دون API أو رفع بيانات ----------
let coachBusy = false;

function coachSetStatus(text, isError = false) {
  el.coachChatStatus.textContent = text;
  el.coachChatStatus.className = "msg" + (isError ? " error" : "");
}

function coachAddMsg(role, text) {
  const box = document.createElement("div");
  box.className = "coach-msg " + role;
  const p = document.createElement("p");
  p.textContent = text;
  box.appendChild(p);
  el.coachChatLog.appendChild(box);
  el.coachChatLog.scrollTop = el.coachChatLog.scrollHeight;
  return box;
}

function normalizeCoachText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[؟?!.,،؛:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function coachHasAny(text, words) {
  return words.some((word) => text.includes(word));
}

function buildPersonalizedProgressReply(sessions, english) {
  if (!sessions.length) {
    return english
      ? "I don't have saved sessions to personalize this yet. Once some history is available, I can use it privately to suggest a more suitable general activity routine."
      : "ما عندي جلسات محفوظة أخصص النصيحة بناءً عليها حتى الآن. عندما يتوفر سجل، أستطيع استخدامه داخليًا لاقتراح روتين نشاط عام أنسب لك.";
  }

  const recent = sessions.slice(0, 5);
  const accuracyValues = recent.filter((s) => typeof s.accuracy === "number").map((s) => s.accuracy);
  const avgAccuracy = accuracyValues.length
    ? accuracyValues.reduce((sum, value) => sum + value, 0) / accuracyValues.length
    : null;
  const avgDuration = recent.reduce((sum, s) => sum + (Number(s.durationSec) || 0), 0) / recent.length;
  const suggestions = [];

  if (sessions.length < 3) {
    suggestions.push(english
      ? "There are only a few saved sessions, so focus on a comfortable, consistent routine before drawing conclusions."
      : "عدد الجلسات المحفوظة ما زال قليلًا؛ ركّز على الانتظام بروتين مريح قبل استخلاص نتائج عن تطورك.");
  }
  if (avgDuration > 0 && avgDuration < 120) {
    suggestions.push(english
      ? "Your sessions tend to be brief. Keep activity manageable and enjoyable, and take breaks when needed rather than chasing a higher score."
      : "جلساتك تميل إلى أن تكون قصيرة؛ حافظ على نشاط مريح وممتع وخذ فترات راحة عند الحاجة بدل مطاردة نتيجة أعلى.");
  }
  if (avgAccuracy !== null && avgAccuracy < 50) {
    suggestions.push(english
      ? "The camera-based score has been low, but tracking can be inaccurate. Check that the phone is stable and lighting is clear; treat the score as an estimate, not a judgment of your ability."
      : "نتيجة التتبّع بالكاميرا كانت منخفضة، لكن التتبّع قد يخطئ. تأكد من ثبات الهاتف ووضوح الإضاءة، واعتبر النتيجة تقديرًا لا حكمًا على قدرتك.");
  }
  if (!suggestions.length) {
    suggestions.push(english
      ? "Keep your routine comfortable and consistent, leave time for recovery, and focus on how you feel rather than trying to beat a number every session."
      : "حافظ على روتين مريح ومنتظم، واترك وقتًا كافيًا للتعافي، واهتم بشعورك وطاقتك بدل محاولة تحطيم رقم في كل جلسة.");
  }
  return (english ? "Based on your saved progress, here's a useful next step:\n• " : "بناءً على سجل تقدمك، هذه خطوة مفيدة لك:\n• ") + suggestions.join("\n• ");
}

function buildLocalCoachReply(question) {
  const q = normalizeCoachText(question);
  const english = lang === "en";
  const sessions = loadSessions();
  const latest = sessions[0] || null;
  const has = (words) => coachHasAny(q, words);

  if (has(["الم", "وجع", "اصابه", "injury", "pain", "hurt", "hurt"])) {
    return english
      ? "Safety first: stop the session if you feel pain, dizziness, or unusual discomfort. Do not try to punch through it. Tell a trusted adult and get advice from a qualified health professional before returning."
      : "السلامة أولًا: أوقف التدريب إذا شعرت بألم أو دوخة أو انزعاج غير معتاد. لا تحاول مواصلة اللكم رغم الألم. أخبر شخصًا بالغًا تثق به واستشر مختصًا صحيًا قبل العودة للتدريب.";
  }

  if (has(["جلسه", "ادائي", "تقييمي", "نتائج", "تقدم", "احصائيات", "session", "performance", "progress", "stats", "last workout", "review"])) {
    return buildPersonalizedProgressReply(sessions, english);
  }

  if (has(["طور نفسي", "اطور", "تحسين مستواي", "كيف اتحسن", "اتقدم اكثر", "احسن ادائي", "improve myself", "how can i improve", "get better", "improve my progress", "level up", "improve my performance"])) {
    return buildPersonalizedProgressReply(sessions, english);
  }

  if (has(["كومبو", "تركيبه", "تركيبات", "combo", "combination", "sequence"])) {
    return english
      ? "Beginner combo: 1) Jab, 2) Cross, 3) return both hands to guard. Start slowly for 5–8 clean repetitions, keep your balance, and exhale gently with each punch. Add a hook only when the first two punches feel controlled."
      : "كومبو للمبتدئين: ١) جاب، ٢) كروس، ٣) أعد اليدين إلى وضع الحراسة. ابدأ بـ٥–٨ تكرارات بطيئة ونظيفة، وحافظ على توازنك وأخرج النفس بهدوء مع كل لكمة. أضف الهوك فقط عندما تتحكم في اللكمتين الأولى والثانية.";
  }

  if (has(["دقه", "هدف", "اهداف", "اصابه", "اخفاق", "miss", "accuracy", "target", "hit rate"])) {
    return english
      ? "For cleaner target contact: slow down first, keep your eyes on the target, extend without locking your elbow, and bring the hand back to guard after each punch. Train accuracy before speed. The app's hit detection is an estimate, so use the score as a guide—not a perfect measurement."
      : "لتحسين دقة إصابة الأهداف: خفّف السرعة أولًا، وركّز نظرك على الهدف، ومدّ الذراع دون قفل المرفق، ثم أعد اليد إلى الحراسة بعد كل لكمة. درّب الدقة قبل السرعة. احتساب التطبيق تقديري، فاعتبر النتيجة مؤشرًا لا قياسًا مثاليًا.";
  }

  if (has(["دفاع", "تفادي", "مراوغه", "حاجز", "حراسه", "slip", "dodge", "defense", "guard", "block"])) {
    return english
      ? "Defense basics: keep your hands near your cheeks, chin slightly tucked, and knees relaxed. Move your head a little off the center line while keeping balance; avoid huge bends or sudden twisting. Practise slowly in a clear space."
      : "أساسيات الدفاع: أبقِ يديك قرب الخدين، والذقن منخفضًا قليلًا، والركبتين مرتاحتين. حرّك الرأس قليلًا خارج خط المنتصف مع الحفاظ على التوازن، وتجنّب الانحناء المبالغ فيه أو الالتواء المفاجئ. تدرّب ببطء وفي مساحة خالية.";
  }

  if (has(["جاب", "كروس", "هوك", "uppercut", "jab", "cross", "hook", "لكمه", "لكمات", "punch"])) {
    return english
      ? "Technique checkpoint: keep the non-punching hand in guard, rotate from the hips and torso without forcing the shoulder, keep your wrist aligned with the forearm, then return to guard. Practise at low speed first. Which punch do you want to focus on: jab, cross, or hook?"
      : "نقاط تقنية: أبقِ اليد غير الضاربة في الحراسة، ودوّر الورك والجذع دون إجبار الكتف، وحافظ على استقامة المعصم مع الساعد، ثم أعد اليد إلى الحراسة. تدرّب بسرعة منخفضة أولًا. أي لكمة تريد التركيز عليها: الجاب أم الكروس أم الهوك؟";
  }

  if (has(["سرعه", "سرعتي", "تحمل", "تعب", "stamina", "speed", "pace", "endurance"])) {
    return english
      ? "Build pace gradually: use short rounds, keep a rhythm you can control, and rest between rounds. Don't chase a high punch count if your technique becomes messy. Track one thing per session—steady pace, clean form, or recovery."
      : "طوّر الإيقاع تدريجيًا: استخدم جولات قصيرة، وحافظ على سرعة تستطيع التحكم بها، واسترح بين الجولات. لا تطارد عدد لكمات كبيرًا إذا بدأت التقنية تتدهور. تابع شيئًا واحدًا في كل جلسة: ثبات الإيقاع أو نظافة الحركة أو التعافي.";
  }

  if (has(["مرحبا", "اهلا", "السلام", "help", "ماذا تستطيع", "كيف تساعد", "hello", "hi"])) {
    return english
      ? "I'm your local boxing coach. I can suggest beginner combos, explain punch technique and defense, help improve target accuracy, and summarize saved session stats. I don't watch or analyze your camera feed."
      : "أنا مدرّبك المحلي للملاكمة. أستطيع اقتراح كومبوهات للمبتدئين، وشرح التقنية والدفاع، ومساعدتك على تحسين دقة الأهداف، وتلخيص أرقام الجلسات المحفوظة. لا أشاهد الكاميرا ولا أحلل صورتك مباشرة.";
  }

  return english
    ? "I can help with boxing basics, jab/cross/hook technique, beginner combos, defense, target accuracy, pacing, and saved session stats. Try one of the quick questions above, or ask one specific thing. I only use local rules and saved session numbers."
    : "أستطيع مساعدتك في أساسيات الملاكمة، وتقنية الجاب والكروس والهوك، والكومبوهات، والدفاع، ودقة الأهداف، والإيقاع، وأرقام جلساتك المحفوظة. جرّب أحد الأسئلة السريعة أعلاه أو اسألني عن نقطة محددة. أستخدم قواعد محلية وأرقام الجلسات فقط.";
}

function askCoach(question) {
  if (coachBusy) return;
  coachBusy = true;
  el.coachChatSend.disabled = true;
  coachSetStatus("");
  coachAddMsg("user", question);
  coachAddMsg("bot", buildLocalCoachReply(question));
  coachBusy = false;
  el.coachChatSend.disabled = false;
}

const COACH_QUICK_PROMPTS = {
  session: ["قيّم آخر جلسة", "Review my last session"],
  combo: ["أعطني كومبو للمبتدئين", "Give me a beginner combo"],
  accuracy: ["كيف أحسّن دقة اللكمات؟", "How can I improve punch accuracy?"],
  defense: ["علّمني أساسيات الدفاع", "Teach me basic defense"],
  progress: ["كيف أطور نفسي حسب تقدمي؟", "How can I improve based on my progress?"]
};
document.querySelectorAll("[data-coach-prompt]").forEach((button) => {
  button.addEventListener("click", () => askCoach(COACH_QUICK_PROMPTS[button.dataset.coachPrompt][lang === "en" ? 1 : 0]));
});

el.coachChatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const question = el.coachChatInput.value.trim();
  if (!question) return;
  if (question.length > 500) {
    coachSetStatus(t("coach_chat_long"), true);
    return;
  }
  el.coachChatInput.value = "";
  askCoach(question);
});
el.btnCloseCoach.addEventListener("click", () => (el.coachModal.hidden = true));

// الأقسام الأربعة في الرئيسية
el.btnTraining.addEventListener("click", () => showScreen("trainMenu"));
el.btnLearn.addEventListener("click", () => {
  window.location.href = "learning-hub.html?v=20261018b";
});
el.btnTrainBack.addEventListener("click", () => showScreen("home"));
el.btnLearnBack.addEventListener("click", () => showScreen("home"));

el.calibBtn.addEventListener("click", () => {
  if (calibReady) startRound();
});
el.calibCancel.addEventListener("click", exitTraining);
el.restAdd20.addEventListener("click", () => {
  if (state !== "rest") return;
  restMs += 20000;
  updateHud();
});
el.restSkip.addEventListener("click", () => startRound());
el.btnPause.addEventListener("click", togglePause);
el.btnResume.addEventListener("click", togglePause);
el.btnStance.addEventListener("click", () => {
  stance = stance === "orthodox" ? "southpaw" : "orthodox";
  showToast(stance === "orthodox" ? t("toast_left_lead") : t("toast_right_lead"));
  updateHud();
});
el.btnCam.addEventListener("click", switchCamera);
el.btnRotate.addEventListener("click", () => {
  rotAuto = false;
  rot = (rot + 1) % 4;
  videoKey = "";
  updateLayout();
  showToast(t("toast_rot", { d: rot * 90 }));
});
el.btnStop.addEventListener("click", () => {
  if (state === "calib" || state === "home") exitTraining();
  else finishSession();
});
el.btnAgain.addEventListener("click", async () => {
  exitTraining();
  await startSession();
});
el.btnHome.addEventListener("click", () => exitTraining("home"));

// شاشة الدخول: الضغط عليها يفعّل الصوت ويشغّل نغمة الدخول
el.splash.addEventListener("click", () => {
  try { sessionStorage.setItem("nox_splash_dismissed", "1"); } catch {}
  getAudio();
  tone(440, 0.15, 0.2, "sine");
  setTimeout(() => tone(660, 0.15, 0.2, "sine"), 150);
  setTimeout(() => tone(880, 0.3, 0.25, "triangle"), 300);
  el.splash.classList.add("hide");
  setTimeout(() => (el.splash.hidden = true), 700);
}, { once: true });

// زر إظهار/إخفاء لوحة النتائج لترى الضربات في أسفل الشاشة
el.btnStats.addEventListener("click", () => setStatsHidden(!statsHidden));
el.btnLabels.addEventListener("click", () => setLabels(!labelsOn));

window.addEventListener("resize", () => {
  if (state !== "home") resizeCanvas();
});

// إيقاف الجولة تلقائيًا إذا خرج المستخدم من التبويب
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state === "round") setState("paused");
});

// ---------- التهيئة ----------
// عند الرجوع من صفحة المدرّب إلى التطبيق، لا نعرض شاشة «اضغط للدخول» مرة ثانية في الجلسة نفسها.
try {
  if (sessionStorage.getItem("nox_splash_dismissed") === "1") {
    el.splash.classList.add("hide");
    el.splash.hidden = true;
  }
} catch {}
applyPrefs();
applyLang();
if (!window.isSecureContext) el.banner.hidden = false;
updateHud();

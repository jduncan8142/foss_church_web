// FOSS Church — front-end interactions. Vanilla JS, no dependencies.
(function () {
  "use strict";

  /* ---- Footer year ---- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ---- Sticky header shadow on scroll ---- */
  var header = document.querySelector(".site-header");
  function onScroll() {
    if (!header) return;
    header.classList.toggle("scrolled", window.scrollY > 8);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---- Mobile nav toggle ---- */
  var toggle = document.querySelector(".nav-toggle");
  var menu = document.getElementById("nav-menu");
  function closeMenu(returnFocus) {
    if (!toggle || !menu) return;
    var wasOpen = menu.classList.contains("open");
    toggle.setAttribute("aria-expanded", "false");
    menu.classList.remove("open");
    if (returnFocus && wasOpen) toggle.focus();
  }
  function openMenu() {
    if (!toggle || !menu) return;
    toggle.setAttribute("aria-expanded", "true");
    menu.classList.add("open");
    var firstLink = menu.querySelector("a");
    if (firstLink) firstLink.focus();
  }
  if (toggle && menu) {
    toggle.addEventListener("click", function () {
      if (toggle.getAttribute("aria-expanded") === "true") closeMenu(true);
      else openMenu();
    });
    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) closeMenu(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeMenu(true);
    });
    // Reset the menu's state/icon if the viewport grows past the mobile breakpoint.
    if (window.matchMedia) {
      var mq = window.matchMedia("(min-width: 761px)");
      var onBreakpoint = function (e) {
        if (e.matches) closeMenu(false);
      };
      if (mq.addEventListener) mq.addEventListener("change", onBreakpoint);
      else if (mq.addListener) mq.addListener(onBreakpoint);
    }
  }

  /* ---- Reveal on scroll ---- */
  var revealEls = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  var prefersReduced =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (prefersReduced || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) {
      el.classList.add("is-visible");
    });
  } else {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    // Stagger siblings slightly for a polished cascade.
    revealEls.forEach(function (el, i) {
      el.style.transitionDelay = Math.min((i % 6) * 60, 300) + "ms";
      io.observe(el);
    });
  }

  /* ---- Pointer-follow glow on cards ---- */
  if (!prefersReduced) {
    document.querySelectorAll(".card").forEach(function (card) {
      card.addEventListener("pointermove", function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty("--mx", e.clientX - r.left + "px");
        card.style.setProperty("--my", e.clientY - r.top + "px");
      });
    });
  }

  /* ---- Contact form ---- */
  var form = document.getElementById("contact-form");
  if (!form) return;

  var status = document.getElementById("form-status");
  var submitBtn = form.querySelector(".btn-submit");
  var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  /* ---- Cloudflare Turnstile (only loaded when configured server-side) ---- */
  var turnstileSiteKey = null;
  var turnstileWidgetId = null;
  fetch("/api/config")
    .then(function (r) {
      return r.json();
    })
    .then(function (cfg) {
      turnstileSiteKey = cfg && cfg.turnstileSiteKey;
      if (!turnstileSiteKey) return;
      window.__fcTurnstileOnload = function () {
        try {
          turnstileWidgetId = window.turnstile.render("#cf-turnstile", {
            sitekey: turnstileSiteKey,
            theme: "dark",
          });
        } catch (e) {}
      };
      var s = document.createElement("script");
      s.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__fcTurnstileOnload";
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    })
    .catch(function () {});

  function turnstileToken() {
    if (!turnstileSiteKey) return null; // captcha not configured -> not required
    return (window.turnstile && window.turnstile.getResponse(turnstileWidgetId)) || "";
  }
  function turnstileReset() {
    if (turnstileSiteKey && window.turnstile) {
      try {
        window.turnstile.reset(turnstileWidgetId);
      } catch (e) {}
    }
  }

  function setStatus(message, kind) {
    if (!status) return;
    status.textContent = message;
    status.className = "form-status show " + (kind || "");
  }

  function fieldInvalid(el, bad) {
    if (!el) return;
    el.classList.toggle("invalid", !!bad);
    if (bad) el.setAttribute("aria-invalid", "true");
    else el.removeAttribute("aria-invalid");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    var nameEl = form.elements.namedItem("name");
    var emailEl = form.elements.namedItem("email");
    var messageEl = form.elements.namedItem("message");

    var name = (nameEl.value || "").trim();
    var email = (emailEl.value || "").trim();
    var message = (messageEl.value || "").trim();

    var nameBad = name.length < 2;
    var emailBad = !emailRe.test(email);
    var messageBad = message.length < 5;

    fieldInvalid(nameEl, nameBad);
    fieldInvalid(emailEl, emailBad);
    fieldInvalid(messageEl, messageBad);

    if (nameBad || emailBad || messageBad) {
      setStatus("Please fill in your name, a valid email, and a short message.", "error");
      (nameBad ? nameEl : emailBad ? emailEl : messageEl).focus();
      return;
    }

    var tsToken = turnstileToken();
    if (turnstileSiteKey && !tsToken) {
      setStatus("Please complete the captcha below before sending.", "error");
      return;
    }

    var services = Array.prototype.slice
      .call(form.querySelectorAll('input[name="services"]:checked'))
      .map(function (cb) {
        return cb.value;
      });

    var payload = {
      name: name,
      email: email,
      organization: (form.elements.namedItem("organization").value || "").trim(),
      orgType: form.elements.namedItem("orgType").value || "",
      phone: (form.elements.namedItem("phone").value || "").trim(),
      services: services,
      message: message,
      website: form.elements.namedItem("website").value || "", // honeypot
      turnstileToken: tsToken || "",
    };

    if (submitBtn) submitBtn.classList.add("loading");
    setStatus("Sending your request…", "");

    fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            return { ok: res.ok, data: data };
          });
      })
      .then(function (result) {
        if (result.ok && result.data && result.data.ok) {
          form.reset();
          setStatus(
            "Thank you — your request is in. We'll be in touch within a couple of business days.",
            "success",
          );
        } else {
          var msg =
            (result.data && result.data.error) ||
            "Something went wrong. Please email contact@fosschurch.com directly.";
          setStatus(msg, "error");
        }
      })
      .catch(function () {
        setStatus(
          "We couldn't reach the server. Please check your connection or email contact@fosschurch.com.",
          "error",
        );
      })
      .finally(function () {
        if (submitBtn) submitBtn.classList.remove("loading");
        turnstileReset(); // tokens are single-use; get a fresh one for any retry
      });
  });

  // Clear the invalid state as the user corrects a field.
  ["name", "email", "message"].forEach(function (n) {
    var el = form.elements.namedItem(n);
    if (el)
      el.addEventListener("input", function () {
        el.classList.remove("invalid");
        el.removeAttribute("aria-invalid");
      });
  });
})();

/**
 * Wellness Chatbot admin behaviour.
 * Deliberately tiny — the admin screens are server-rendered forms.
 */
( function () {
	'use strict';

	var strings = ( window.WWC_ADMIN && window.WWC_ADMIN.strings ) || {};

	function confirmBefore( selector, message ) {
		document.querySelectorAll( selector ).forEach( function ( button ) {
			button.addEventListener( 'click', function ( event ) {
				if ( ! window.confirm( message ) ) {
					event.preventDefault();
				}
			} );
		} );
	}

	/**
	 * POSTs to admin-ajax.php and normalises the wp_send_json_success/error
	 * envelope into { ok, data }. Never rejects — a network failure comes
	 * back as ok:false with a message, same shape as a server-side error, so
	 * callers only need one branch.
	 */
	function ajaxRequest( action, params ) {
		var config = window.WWC_ADMIN || {};
		var body = new URLSearchParams(
			Object.assign( { action: action, nonce: config.nonce }, params || {} )
		);
		return fetch( config.ajaxUrl, { method: 'POST', credentials: 'same-origin', body: body } )
			.then( function ( res ) {
				return res.json();
			} )
			.then( function ( json ) {
				return { ok: !! json.success, data: json.data };
			} )
			.catch( function () {
				return { ok: false, data: { message: 'Network error — could not reach the site.' } };
			} );
	}

	/**
	 * Drives the "Run AI labeling" panel: starts a background job, polls its
	 * status, and renders a live progress bar and log — no page reload, no
	 * request left open long enough to time out. See
	 * WWC_Admin_Labels::render_run_labeling() for the markup this reads.
	 */
	function initLabelingRunner() {
		var root = document.getElementById( 'wwc-run-labeling' );
		if ( ! root ) {
			return;
		}

		var limitInput    = document.getElementById( 'wwc-label-limit' );
		var reindexInput  = document.getElementById( 'wwc-label-reindex' );
		var startButton   = document.getElementById( 'wwc-label-start' );
		var panel         = document.getElementById( 'wwc-label-progress' );
		var fill          = document.getElementById( 'wwc-label-progress-fill' );
		var summary       = document.getElementById( 'wwc-label-progress-summary' );
		var logEl         = document.getElementById( 'wwc-label-log' );
		var previewButton = document.getElementById( 'wwc-preview-eligible' );
		var previewList   = document.getElementById( 'wwc-eligible-list' );

		var pollTimer = null;
		var renderedLogCount = 0;

		function setControlsEnabled( enabled ) {
			startButton.disabled = ! enabled;
			limitInput.disabled = ! enabled;
			reindexInput.disabled = ! enabled;
		}

		function stopPolling() {
			if ( pollTimer ) {
				window.clearInterval( pollTimer );
				pollTimer = null;
			}
		}

		function startPolling() {
			stopPolling();
			pollTimer = window.setInterval( poll, 2500 );
		}

		function renderJob( job ) {
			if ( ! job ) {
				return;
			}

			panel.hidden = false;

			var pct = job.total > 0 ? Math.round( ( job.done / job.total ) * 100 ) : ( 'running' === job.status ? 0 : 100 );
			fill.style.width = pct + '%';

			summary.textContent = job.total > 0
				? ( job.done + ' of ' + job.total + ' processed — ' + job.labeled + ' labeled, ' + job.failed + ' failed' )
				: ( 'running' === job.status ? 'Starting…' : ( job.labeled + ' labeled, ' + job.failed + ' failed' ) );

			// Only append entries this page hasn't rendered yet — the backend
			// returns the whole (capped) log every poll, not a delta.
			job.log.slice( renderedLogCount ).forEach( function ( entry ) {
				var line = document.createElement( 'p' );
				line.className = 'wwc-log-line wwc-log-' + entry.level;
				line.textContent = entry.message;
				logEl.appendChild( line );
			} );
			renderedLogCount = job.log.length;
			logEl.scrollTop = logEl.scrollHeight;

			if ( 'running' === job.status ) {
				setControlsEnabled( false );
				return;
			}

			setControlsEnabled( true );
			stopPolling();

			if ( 'completed' === job.status ) {
				var note = document.createElement( 'p' );
				note.className = 'wwc-log-line wwc-log-done';
				note.textContent = 'Finished. Reload the page to see new drafts in the queue below.';
				logEl.appendChild( note );
				logEl.scrollTop = logEl.scrollHeight;
			}
		}

		function poll() {
			ajaxRequest( 'wwc_labeling_status' ).then( function ( result ) {
				if ( result.ok && result.data && result.data.job ) {
					renderJob( result.data.job );
				}
			} );
		}

		// Recover a run already in progress — e.g. this page was reloaded, or
		// opened in a second tab, while a labeling batch was still going.
		poll();

		startButton.addEventListener( 'click', function () {
			var limit = parseInt( limitInput.value, 10 ) || 25;
			if ( ! window.confirm( 'Run AI labeling on up to ' + limit + ' products now? They will go straight to verified and recommendable — no review step, for any category.' ) ) {
				return;
			}

			setControlsEnabled( false );
			renderedLogCount = 0;
			logEl.innerHTML = '';
			panel.hidden = false;
			summary.textContent = 'Starting…';

			ajaxRequest( 'wwc_start_labeling', {
				limit: limit,
				reindex: reindexInput.checked ? '1' : '',
			} ).then( function ( result ) {
				if ( result.ok ) {
					renderJob( result.data.job );
					startPolling();
				} else if ( result.data && result.data.job ) {
					// A run was already in progress (maybe started from another
					// tab) — watch that one instead of failing outright.
					renderJob( result.data.job );
					startPolling();
				} else {
					setControlsEnabled( true );
					summary.textContent = ( result.data && result.data.message ) || 'Could not start labeling.';
				}
			} );
		} );

		if ( previewButton && previewList ) {
			var previewLoaded = false;
			previewButton.addEventListener( 'click', function () {
				if ( ! previewList.hidden ) {
					previewList.hidden = true;
					return;
				}
				previewList.hidden = false;
				if ( previewLoaded ) {
					return;
				}
				previewLoaded = true;
				previewList.textContent = 'Loading…';

				ajaxRequest( 'wwc_eligible_products' ).then( function ( result ) {
					if ( ! result.ok || ! result.data ) {
						previewList.textContent = 'Could not load the list.';
						return;
					}
					var products = result.data.products || [];
					if ( ! products.length ) {
						previewList.textContent = 'Nothing is currently eligible — every product has already been through labeling at least once.';
						return;
					}
					previewList.innerHTML = '';
					var list = document.createElement( 'ul' );
					products.forEach( function ( product ) {
						var item = document.createElement( 'li' );
						item.textContent = product.name + ' (#' + product.product_id + ')';
						list.appendChild( item );
					} );
					previewList.appendChild( list );

					if ( result.data.total_eligible > products.length ) {
						var more = document.createElement( 'p' );
						more.className = 'description';
						more.textContent = '…and ' + ( result.data.total_eligible - products.length ) + ' more.';
						previewList.appendChild( more );
					}
				} );
			} );
		}
	}

	document.addEventListener( 'DOMContentLoaded', function () {
		initLabelingRunner();

		confirmBefore(
			'.wwc-confirm-reject',
			strings.confirmReject || 'Reject this AI draft?'
		);
		confirmBefore(
			'.wwc-confirm-delete',
			'Delete this entry? This cannot be undone.'
		);
		confirmBefore(
			'.wwc-confirm-bulk-verified',
			'Approve every selected product as verified? This uses the raw AI draft as-is, with no edits.'
		);
		confirmBefore(
			'.wwc-confirm-bulk-partial',
			'Approve every selected product as partial? This uses the raw AI draft as-is, with no edits.'
		);
		confirmBefore(
			'.wwc-confirm-reset',
			'Clear every unreviewed AI draft and reset those products back to never-labeled? This cannot be undone. Verified and partial products are not affected.'
		);

		// Bulk-select bar: keep both submit buttons disabled until something is
		// actually selected, and let "select all" toggle every eligible row.
		var rowChecks = document.querySelectorAll( '.wwc-row-check' );
		var bulkSubmitButtons = document.querySelectorAll( '.wwc-bulk-submit-btn' );
		var selectAll = document.getElementById( 'wwc-select-all' );

		function updateBulkSubmit() {
			if ( ! bulkSubmitButtons.length ) {
				return;
			}
			var anyChecked = Array.prototype.some.call( rowChecks, function ( c ) {
				return c.checked;
			} );
			bulkSubmitButtons.forEach( function ( button ) {
				button.disabled = ! anyChecked;
			} );
		}

		rowChecks.forEach( function ( checkbox ) {
			checkbox.addEventListener( 'change', updateBulkSubmit );
		} );

		if ( selectAll ) {
			selectAll.addEventListener( 'change', function () {
				rowChecks.forEach( function ( checkbox ) {
					checkbox.checked = selectAll.checked;
				} );
				updateBulkSubmit();
			} );
		}

		// Approving is the consequential action on this screen, so make the
		// double-submit impossible rather than merely unlikely.
		document.querySelectorAll( '.wwc-review-form' ).forEach( function ( form ) {
			form.addEventListener( 'submit', function () {
				form.querySelectorAll( 'button[type="submit"]' ).forEach( function ( button ) {
					button.disabled = true;
				} );
				var pending = form.querySelector( '.wwc-review-actions' );
				if ( pending ) {
					var note = document.createElement( 'span' );
					note.className = 'wwc-saving';
					note.textContent = ' ' + ( strings.saving || 'Saving…' );
					pending.appendChild( note );
				}
			} );
		} );
	} );
} )();

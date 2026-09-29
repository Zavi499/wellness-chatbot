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
		var labelAllInput = document.getElementById( 'wwc-label-all' );
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
			limitInput.disabled = ! enabled || labelAllInput.checked;
			labelAllInput.disabled = ! enabled;
			reindexInput.disabled = ! enabled;
		}

		if ( labelAllInput ) {
			labelAllInput.addEventListener( 'change', function () {
				limitInput.disabled = labelAllInput.checked;
			} );
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
			var labelAll = labelAllInput.checked;
			var limit = parseInt( limitInput.value, 10 ) || 25;
			var message = labelAll
				? 'Run AI labeling on the ENTIRE catalogue now — every never-labeled product, no cap? They will go straight to verified and recommendable — no review step, for any category. This can take a while and will use OpenAI credit for every product labeled.'
				: 'Run AI labeling on up to ' + limit + ' products now? They will go straight to verified and recommendable — no review step, for any category.';
			if ( ! window.confirm( message ) ) {
				return;
			}

			setControlsEnabled( false );
			renderedLogCount = 0;
			logEl.innerHTML = '';
			panel.hidden = false;
			summary.textContent = 'Starting…';

			ajaxRequest( 'wwc_start_labeling', {
				limit: limit,
				label_all: labelAll ? '1' : '',
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

	/**
	 * "Show available models" on the Settings screen: fetches the live list
	 * from OpenAI (via the backend, never hardcoded here) and lets a click
	 * fill whichever of the three model inputs was last focused — so picking
	 * one is a single click, not a copy-paste.
	 */
	function initModelPicker() {
		var inputs = document.querySelectorAll( '.wwc-model-input' );
		var fetchButton = document.getElementById( 'wwc-fetch-models' );
		var listEl = document.getElementById( 'wwc-model-list' );
		if ( ! fetchButton || ! listEl || ! inputs.length ) {
			return;
		}

		var lastFocused = inputs[ 0 ];
		inputs.forEach( function ( input ) {
			input.addEventListener( 'focus', function () {
				lastFocused = input;
			} );
		} );

		var loaded = false;
		fetchButton.addEventListener( 'click', function () {
			if ( loaded ) {
				listEl.hidden = ! listEl.hidden;
				return;
			}
			listEl.hidden = false;
			listEl.textContent = 'Loading…';

			ajaxRequest( 'wwc_fetch_openai_models' ).then( function ( result ) {
				if ( ! result.ok || ! result.data || ! result.data.models || ! result.data.models.length ) {
					listEl.textContent = ( result.data && result.data.message ) ||
						'Could not reach OpenAI. Check the backend’s OPENAI_API_KEY and its network access.';
					return;
				}
				loaded = true;
				listEl.innerHTML = '';
				var list = document.createElement( 'ul' );
				result.data.models.forEach( function ( id ) {
					var item = document.createElement( 'li' );
					var pick = document.createElement( 'button' );
					pick.type = 'button';
					pick.className = 'button-link';
					pick.textContent = id;
					pick.addEventListener( 'click', function () {
						( lastFocused || inputs[ 0 ] ).value = id;
						( lastFocused || inputs[ 0 ] ).focus();
					} );
					item.appendChild( pick );
					list.appendChild( item );
				} );
				listEl.appendChild( list );
			} );
		} );
	}

	/**
	 * "Resync all products": asks the site for one batch at a time until the
	 * catalogue is exhausted, so no single request runs long enough to time
	 * out. See WWC_Admin_Accuracy::ajax_resync_chunk().
	 */
	function initResync() {
		var button = document.getElementById( 'wwc-resync-start' );
		var status = document.getElementById( 'wwc-resync-status' );
		if ( ! button || ! status ) {
			return;
		}

		button.addEventListener( 'click', function () {
			var sent = 0;
			button.disabled = true;

			function step( page ) {
				status.textContent = 'Sending batch ' + page + '… (' + sent + ' products so far)';
				ajaxRequest( 'wwc_resync_chunk', { page: page } ).then( function ( result ) {
					if ( ! result.ok ) {
						status.textContent = 'Stopped at batch ' + page + ': ' + ( ( result.data && result.data.message ) || 'unknown error' ) + '. ' + sent + ' products were sent — click again to retry.';
						button.disabled = false;
						return;
					}
					sent += result.data.sent;
					if ( result.data.done ) {
						status.textContent = 'Done — ' + sent + ' products resynced. Reload this page to see the categories.';
						button.disabled = false;
						return;
					}
					step( page + 1 );
				} );
			}

			step( 1 );
		} );
	}

	function el( tag, className, text ) {
		var node = document.createElement( tag );
		if ( className ) {
			node.className = className;
		}
		if ( text !== undefined && text !== null ) {
			node.textContent = String( text );
		}
		return node;
	}

	var STATUS_TEXT = {
		matched: 'Showing products of the requested type that match the need.',
		type_only: 'None of this type is labelled for the need — showing the same type anyway, with a note saying so.',
		none_of_type: 'The store has no recommendable product of this type. The assistant says so and offers nothing else.',
		need_type: 'No product type was understood — the assistant would ask which kind of product.',
		medicine: 'A medicine was requested — never recommended; the assistant points to a pharmacist.'
	};

	function renderTestResult( container, data ) {
		container.textContent = '';

		if ( ! data.tool ) {
			container.appendChild( el( 'p', '', 'The assistant would not look up products yet. It would reply:' ) );
			container.appendChild( el( 'blockquote', '', data.reply || '(empty reply)' ) );
			return;
		}

		var understood = data.understood || {};
		var summary = el( 'div', 'wwc-card' );
		summary.appendChild( el( 'p', '', 'Tool: ' + data.tool ) );
		if ( data.tool === 'find_products' ) {
			summary.appendChild( el( 'p', '', 'Product type(s): ' + ( ( understood.product_types || [] ).join( ', ' ) || '(none)' ) ) );
			summary.appendChild( el( 'p', '', 'Need: ' + ( [].concat( understood.concerns || [], understood.for_types || [], understood.ingredients_wanted || [] ).join( ', ' ) || '(none stated)' ) ) );
			summary.appendChild( el( 'p', '', STATUS_TEXT[ data.status ] || data.status ) );
			summary.appendChild( el( 'p', 'description',
				data.products_of_type + ' products of this type in the catalogue · ' +
				data.eligible_of_type + ' recommendable · ' +
				data.matching_need + ' labelled for the need' ) );
			var held = Object.keys( data.held_back || {} );
			if ( held.length ) {
				summary.appendChild( el( 'p', 'description', 'Held back: ' + held.map( function ( k ) {
					return k.replace( /_/g, ' ' ) + ' (' + data.held_back[ k ] + ')';
				} ).join( ', ' ) ) );
			}
		} else {
			summary.appendChild( el( 'p', '', 'Looked up by name: ' + ( understood.query || '' ) ) );
		}
		container.appendChild( summary );

		var rows = data.picks || data.results || [];
		if ( ! rows.length ) {
			container.appendChild( el( 'p', '', 'No products would be shown.' ) );
			return;
		}

		var table = el( 'table', 'widefat striped' );
		var head = el( 'tr' );
		[ 'Product', 'Type', 'Labelled for', 'Why' ].forEach( function ( h ) {
			head.appendChild( el( 'th', '', h ) );
		} );
		var thead = el( 'thead' );
		thead.appendChild( head );
		table.appendChild( thead );

		var tbody = el( 'tbody' );
		rows.forEach( function ( row ) {
			var tr = el( 'tr' );
			tr.appendChild( el( 'td', '', row.name + ' (#' + row.product_id + ')' ) );
			tr.appendChild( el( 'td', '', row.product_type_label || row.product_type || 'no type' ) );
			tr.appendChild( el( 'td', '', [].concat( row.concerns || [], row.suitable_types || [] ).join( ', ' ) ) );
			tr.appendChild( el( 'td', '', row.reasons ? row.reasons.join( ' · ' ) : ( 'score ' + row.score ) ) );
			tbody.appendChild( tr );
		} );
		table.appendChild( tbody );
		container.appendChild( table );
	}

	function initTestQuestion() {
		var input = document.getElementById( 'wwc-test-input' );
		var button = document.getElementById( 'wwc-test-run' );
		var result = document.getElementById( 'wwc-test-result' );
		if ( ! input || ! button || ! result ) {
			return;
		}

		function run() {
			var question = input.value.trim();
			if ( ! question ) {
				return;
			}
			button.disabled = true;
			result.textContent = 'Asking the assistant…';
			ajaxRequest( 'wwc_test_question', { question: question } ).then( function ( res ) {
				button.disabled = false;
				if ( ! res.ok ) {
					result.textContent = ( res.data && res.data.message ) || 'The test failed.';
					return;
				}
				renderTestResult( result, res.data );
			} );
		}

		button.addEventListener( 'click', run );
		input.addEventListener( 'keydown', function ( event ) {
			if ( event.key === 'Enter' ) {
				event.preventDefault();
				run();
			}
		} );
	}

	document.addEventListener( 'DOMContentLoaded', function () {
		initLabelingRunner();
		initModelPicker();
		initResync();
		initTestQuestion();

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

		// A dedicated handler rather than confirmBefore(): the warning text
		// itself depends on whether the "include human-verified" checkbox next
		// to this button is checked, since that changes exactly what gets
		// destroyed.
		document.querySelectorAll( '.wwc-confirm-reset-all' ).forEach( function ( button ) {
			button.addEventListener( 'click', function ( event ) {
				var checkbox = document.getElementById( 'wwc-include-human-verified' );
				var includeHuman = !! ( checkbox && checkbox.checked );
				var message = includeHuman
					? 'Reset EVERYTHING with no exceptions — including products a human wrote or verified by hand — back to never-labeled? This is permanent and that hand-written content cannot be regenerated by AI. You will need to run AI labeling again afterwards.'
					: 'Reset ALL AI labels, including ones already verified and live on the site right now, back to never-labeled? This cannot be undone. Products a human wrote or verified themselves are not affected. You will need to run AI labeling again afterwards.';
				if ( ! window.confirm( message ) ) {
					event.preventDefault();
				}
			} );
		} );

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

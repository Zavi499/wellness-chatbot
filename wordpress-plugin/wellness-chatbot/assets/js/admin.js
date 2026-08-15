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

	document.addEventListener( 'DOMContentLoaded', function () {
		confirmBefore(
			'.wwc-confirm-reject',
			strings.confirmReject || 'Reject this AI draft?'
		);
		confirmBefore(
			'.wwc-confirm-delete',
			'Delete this entry? This cannot be undone.'
		);
		confirmBefore(
			'.wwc-confirm-bulk',
			'Approve every selected product as partial? This uses the raw AI draft as-is, with no edits.'
		);
		confirmBefore(
			'.wwc-confirm-reset',
			'Clear every unreviewed AI draft and reset those products back to never-labeled? This cannot be undone. Verified and partial products are not affected.'
		);

		// Run AI labeling: confirm with the actual number about to be spent,
		// read live from the field rather than a generic canned message —
		// this is the control most directly responsible for OpenAI cost.
		document.querySelectorAll( '.wwc-run-labeling-form' ).forEach( function ( form ) {
			form.addEventListener( 'submit', function ( event ) {
				var limitField = form.querySelector( 'input[name="limit"]' );
				var limit = limitField ? ( limitField.value || '25' ) : '25';
				if ( ! window.confirm( 'Run AI labeling on up to ' + limit + ' products now?' ) ) {
					event.preventDefault();
				}
			} );
		} );

		// Bulk-select bar: keep the submit button disabled until something is
		// actually selected, and let "select all" toggle every eligible row.
		var rowChecks = document.querySelectorAll( '.wwc-row-check' );
		var bulkSubmit = document.getElementById( 'wwc-bulk-submit' );
		var selectAll = document.getElementById( 'wwc-select-all' );

		function updateBulkSubmit() {
			if ( ! bulkSubmit ) {
				return;
			}
			var anyChecked = Array.prototype.some.call( rowChecks, function ( c ) {
				return c.checked;
			} );
			bulkSubmit.disabled = ! anyChecked;
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

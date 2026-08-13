<?php
/**
 * Business Settings + connection settings (spec §8.5).
 *
 * This screen exists specifically so no [TO BE CONFIRMED] fact is hardcoded in
 * a prompt or in PHP. Values are pushed to the backend, which reads them live
 * on every conversation turn.
 *
 * @package WellnessChatbot
 */

defined( 'ABSPATH' ) || exit;

class WWC_Admin_Settings {

	const PAGE = 'wellness-chatbot-settings';

	public static function init() {
		add_action( 'admin_post_wwc_save_settings', array( __CLASS__, 'handle_save' ) );
		add_action( 'admin_post_wwc_run_sync', array( __CLASS__, 'handle_sync' ) );
	}

	public static function render() {
		WWC_Admin::page( __( 'Wellness Chatbot Settings', 'wellness-chatbot' ), array( __CLASS__, 'body' ) );
	}

	public static function body() {
		WWC_Admin::render_notice_from_query();

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'wwc_save_settings' );
		echo '<input type="hidden" name="action" value="wwc_save_settings" />';

		self::render_connection();
		self::render_business();
		self::render_widget();

		printf( '<p><button type="submit" class="button button-primary">%s</button></p>', esc_html__( 'Save settings', 'wellness-chatbot' ) );
		echo '</form>';

		self::render_launch_checklist();
		self::render_maintenance();
	}

	private static function render_connection() {
		echo '<h2>' . esc_html__( 'Backend connection', 'wellness-chatbot' ) . '</h2>';
		echo '<table class="form-table" role="presentation"><tbody>';

		printf(
			'<tr><th scope="row"><label for="wwc_backend_url">%s</label></th><td><input type="url" id="wwc_backend_url" name="backend_url" class="regular-text" value="%s" placeholder="https://chatbot.example.com" /><p class="description">%s</p></td></tr>',
			esc_html__( 'Backend URL', 'wellness-chatbot' ),
			esc_attr( get_option( WWC_Settings::OPTION_BACKEND_URL, '' ) ),
			esc_html__( 'Where the Node service is running. The OpenAI key lives there, never here.', 'wellness-chatbot' )
		);

		if ( WWC_Settings::secret_in_config() ) {
			printf(
				'<tr><th scope="row">%s</th><td><code>%s</code><p class="description">%s</p></td></tr>',
				esc_html__( 'Shared secret', 'wellness-chatbot' ),
				esc_html__( 'defined in wp-config.php', 'wellness-chatbot' ),
				esc_html__( 'Good — this is the safest place for it.', 'wellness-chatbot' )
			);
		} else {
			printf(
				'<tr><th scope="row"><label for="wwc_shared_secret">%s</label></th><td><input type="password" id="wwc_shared_secret" name="shared_secret" class="regular-text" value="%s" autocomplete="new-password" /><p class="description">%s</p></td></tr>',
				esc_html__( 'Shared secret', 'wellness-chatbot' ),
				esc_attr( get_option( WWC_Settings::OPTION_SHARED_SECRET, '' ) ),
				esc_html__( 'Must match WP_SHARED_SECRET on the backend. Better still, move it to wp-config.php as WELLNESS_CHATBOT_SECRET and clear this field.', 'wellness-chatbot' )
			);
		}

		echo '</tbody></table>';

		self::render_health();
	}

	private static function render_health() {
		if ( ! WWC_Settings::is_connected() ) {
			return;
		}

		$status = WWC_Backend_Client::get( '/api/admin/status' );
		if ( is_wp_error( $status ) ) {
			printf(
				'<div class="notice notice-error inline"><p>%s %s</p></div>',
				esc_html__( 'Could not reach the backend:', 'wellness-chatbot' ),
				esc_html( $status->get_error_message() )
			);
			return;
		}

		$products = isset( $status['products'] ) ? $status['products'] : array();
		printf(
			'<div class="notice notice-success inline"><p>%s</p></div>',
			esc_html(
				sprintf(
					/* translators: 1: total products, 2: recommendable products, 3: vectors. */
					__( 'Connected. %1$d products synced, %2$d recommendable, %3$d search vectors.', 'wellness-chatbot' ),
					isset( $products['total'] ) ? (int) $products['total'] : 0,
					isset( $products['verified'] ) ? (int) $products['verified'] : 0,
					isset( $status['vectors'] ) ? (int) $status['vectors'] : 0
				)
			)
		);
	}

	private static function render_business() {
		echo '<h2>' . esc_html__( 'Business facts', 'wellness-chatbot' ) . '</h2>';
		echo '<p class="description">' . esc_html__( 'The assistant reads these live and will never state a value you have not filled in — it offers to check with the team instead. Leave a field empty rather than guessing.', 'wellness-chatbot' ) . '</p>';

		echo '<table class="form-table" role="presentation"><tbody>';
		foreach ( WWC_Settings::business_fields() as $key => $field ) {
			$value    = WWC_Settings::business_value( $key );
			$is_long  = in_array( $key, array( 'delivery_areas', 'loyalty_rules', 'returns_policy', 'payment_methods' ), true );
			$input_id = 'wwc_business_' . $key;

			printf( '<tr><th scope="row"><label for="%s">%s</label></th><td>', esc_attr( $input_id ), esc_html( $field['label'] ) );

			if ( $is_long ) {
				printf(
					'<textarea id="%s" name="business[%s]" rows="3" class="large-text">%s</textarea>',
					esc_attr( $input_id ),
					esc_attr( $key ),
					esc_textarea( $value )
				);
			} else {
				printf(
					'<input type="text" id="%s" name="business[%s]" class="regular-text" value="%s" />',
					esc_attr( $input_id ),
					esc_attr( $key ),
					esc_attr( $value )
				);
			}

			printf( '<p class="description">%s</p>', esc_html( $field['help'] ) );
			if ( '' === trim( $value ) && 'currency' !== $key ) {
				printf( '<p class="wwc-flag wwc-flag-warn">%s</p>', esc_html__( 'not confirmed yet', 'wellness-chatbot' ) );
			}
			echo '</td></tr>';
		}
		echo '</tbody></table>';
	}

	private static function render_widget() {
		echo '<h2>' . esc_html__( 'Widget', 'wellness-chatbot' ) . '</h2>';
		echo '<table class="form-table" role="presentation"><tbody>';

		printf(
			'<tr><th scope="row">%s</th><td><label><input type="checkbox" name="auto_inject" value="1"%s /> %s</label><p class="description">%s</p></td></tr>',
			esc_html__( 'Floating launcher', 'wellness-chatbot' ),
			checked( WWC_Settings::auto_inject(), true, false ),
			esc_html__( 'Show the chat launcher on every storefront page', 'wellness-chatbot' ),
			esc_html__( 'Leave this off to place the widget manually with the [wellness_chatbot] shortcode.', 'wellness-chatbot' )
		);

		printf(
			'<tr><th scope="row">%s</th><td><label><input type="checkbox" name="relabel_on_save" value="1"%s /> %s</label><p class="description">%s</p></td></tr>',
			esc_html__( 'Re-run AI labeling on save', 'wellness-chatbot' ),
			checked( WWC_Settings::relabel_on_save(), true, false ),
			esc_html__( 'Ask the backend to re-label a product whenever it is saved', 'wellness-chatbot' ),
			esc_html__( 'Off by default: a bulk price edit would otherwise trigger a catalogue-wide model spend. New drafts still need human approval either way.', 'wellness-chatbot' )
		);

		echo '</tbody></table>';

		$pharmacists = WWC_Roles::pharmacists();
		echo '<h3>' . esc_html__( 'Pharmacist reviewers', 'wellness-chatbot' ) . '</h3>';
		if ( empty( $pharmacists ) ) {
			printf(
				'<p class="wwc-flag wwc-flag-warn">%s</p>',
				esc_html__( 'Nobody holds the Pharmacist Reviewer capability yet. Until someone does, no supplement or pregnancy-related product can be verified, and the assistant will not recommend any of them.', 'wellness-chatbot' )
			);
		} else {
			echo '<ul class="wwc-list">';
			foreach ( $pharmacists as $user ) {
				printf( '<li>%s (%s)</li>', esc_html( $user->display_name ), esc_html( $user->user_email ) );
			}
			echo '</ul>';
		}
	}

	private static function render_launch_checklist() {
		$missing     = WWC_Settings::missing_business_fields();
		$pharmacists = WWC_Roles::pharmacists();

		$items = array(
			array( empty( $missing ), __( 'All business facts confirmed and entered', 'wellness-chatbot' ) ),
			array( WWC_Settings::is_connected(), __( 'Backend connected', 'wellness-chatbot' ) ),
			array( ! empty( $pharmacists ), __( 'At least one pharmacist reviewer assigned', 'wellness-chatbot' ) ),
			array( '' !== WWC_Settings::business_value( 'whatsapp_number' ) || '' !== WWC_Settings::business_value( 'phone_number' ), __( 'Human handover channel configured', 'wellness-chatbot' ) ),
			array( '' !== WWC_Settings::business_value( 'returns_policy' ), __( 'Returns / exchange / refund policy explicitly confirmed', 'wellness-chatbot' ) ),
		);

		echo '<h2>' . esc_html__( 'Launch checklist', 'wellness-chatbot' ) . '</h2>';
		echo '<ul class="wwc-checklist">';
		foreach ( $items as $item ) {
			printf(
				'<li class="%s">%s</li>',
				$item[0] ? 'wwc-done' : 'wwc-todo',
				esc_html( $item[1] )
			);
		}
		echo '</ul>';
		echo '<p class="description">' . esc_html__( 'Also confirm before go-live: Arabic wording reviewed by a fluent speaker, emergency and pharmacist escalation paths tested end to end, and a named owner responsible for label review and KB updates.', 'wellness-chatbot' ) . '</p>';
	}

	private static function render_maintenance() {
		echo '<h2>' . esc_html__( 'Maintenance', 'wellness-chatbot' ) . '</h2>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'wwc_run_sync' );
		echo '<input type="hidden" name="action" value="wwc_run_sync" />';
		printf(
			'<p><label><input type="checkbox" name="reindex" value="1" checked="checked" /> %s</label></p>',
			esc_html__( 'Rebuild the search index afterwards', 'wellness-chatbot' )
		);
		printf(
			'<p><label><input type="checkbox" name="label" value="1" /> %s</label></p>',
			esc_html__( 'Also run AI labeling on products that have no draft yet (uses OpenAI credit)', 'wellness-chatbot' )
		);
		printf( '<p><button type="submit" class="button">%s</button></p>', esc_html__( 'Sync catalogue from WooCommerce', 'wellness-chatbot' ) );
		echo '</form>';
	}

	public static function handle_save() {
		WWC_Admin::verify_post( 'wwc_save_settings' );

		if ( isset( $_POST['backend_url'] ) ) {
			update_option( WWC_Settings::OPTION_BACKEND_URL, esc_url_raw( wp_unslash( $_POST['backend_url'] ) ) );
		}
		if ( isset( $_POST['shared_secret'] ) && ! WWC_Settings::secret_in_config() ) {
			update_option( WWC_Settings::OPTION_SHARED_SECRET, sanitize_text_field( wp_unslash( $_POST['shared_secret'] ) ) );
		}

		update_option( WWC_Settings::OPTION_AUTO_INJECT, empty( $_POST['auto_inject'] ) ? '0' : '1' );
		update_option( WWC_Settings::OPTION_RELABEL, empty( $_POST['relabel_on_save'] ) ? '0' : '1' );

		$business = array();
		if ( isset( $_POST['business'] ) && is_array( $_POST['business'] ) ) {
			foreach ( wp_unslash( $_POST['business'] ) as $key => $value ) { // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
				$business[ sanitize_key( $key ) ] = sanitize_textarea_field( $value );
			}
		}
		update_option( WWC_Settings::OPTION_BUSINESS, $business );
		update_option( 'wwc_setup_complete', 1 );
		delete_transient( 'wwc_show_setup_notice' );

		// Push the facts to the backend so the assistant reads them live.
		if ( WWC_Settings::is_connected() ) {
			WWC_Backend_Client::post( '/api/admin/settings', $business );
		}

		WWC_Admin::redirect_back( self::PAGE, array( 'wwc_notice' => 'saved' ) );
	}

	public static function handle_sync() {
		WWC_Admin::verify_post( 'wwc_run_sync' );

		$response = WWC_Backend_Client::post(
			'/api/admin/sync',
			array(
				'reindex' => ! empty( $_POST['reindex'] ),
				'label'   => ! empty( $_POST['label'] ),
			),
			array( 'timeout' => 300 )
		);

		WWC_Admin::redirect_back( self::PAGE, array( 'wwc_notice' => is_wp_error( $response ) ? 'failed' : 'saved' ) );
	}
}

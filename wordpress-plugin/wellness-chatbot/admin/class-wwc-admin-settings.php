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
		add_action( 'admin_post_wwc_export_catalogue', array( __CLASS__, 'handle_export' ) );
		add_action( 'admin_post_wwc_upload_catalogue', array( __CLASS__, 'handle_upload' ) );
		add_action( 'wp_ajax_wwc_fetch_openai_models', array( __CLASS__, 'ajax_fetch_openai_models' ) );
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
		self::render_models();

		printf( '<p><button type="submit" class="button button-primary">%s</button></p>', esc_html__( 'Save settings', 'wellness-chatbot' ) );
		echo '</form>';

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
		echo '<p class="description">' . esc_html__( 'Any admin may approve any product, including those flagged for vitamins/supplements or pregnancy/children/medicine content. A Pharmacist Reviewer is not required — this list is informational, so you know who on the team has that background.', 'wellness-chatbot' ) . '</p>';
		if ( empty( $pharmacists ) ) {
			echo '<p class="description">' . esc_html__( 'Nobody currently holds the Pharmacist Reviewer role.', 'wellness-chatbot' ) . '</p>';
		} else {
			echo '<ul class="wwc-list">';
			foreach ( $pharmacists as $user ) {
				printf( '<li>%s (%s)</li>', esc_html( $user->display_name ), esc_html( $user->user_email ) );
			}
			echo '</ul>';
		}
	}

	/**
	 * Lets an admin fix a wrong or retired OpenAI model id from wp-admin,
	 * without SSH access or a redeploy. Blank means "use whatever the
	 * backend's OPENAI_MODEL_* environment variable is set to".
	 */
	private static function render_models() {
		echo '<h2>' . esc_html__( 'AI models', 'wellness-chatbot' ) . '</h2>';
		echo '<p class="description">' . esc_html__( 'Leave a field blank to use the backend server\'s own default. Setting one here takes effect immediately — no redeploy needed.', 'wellness-chatbot' ) . '</p>';

		$overrides = array(
			'chat'  => '',
			'cheap' => '',
			'label' => '',
		);
		if ( WWC_Settings::is_connected() ) {
			$result = WWC_Backend_Client::get( '/api/admin/openai/model-overrides' );
			if ( ! is_wp_error( $result ) && isset( $result['overrides'] ) && is_array( $result['overrides'] ) ) {
				foreach ( $overrides as $key => $value ) {
					if ( isset( $result['overrides'][ $key ] ) && null !== $result['overrides'][ $key ] ) {
						$overrides[ $key ] = (string) $result['overrides'][ $key ];
					}
				}
			}
		}

		$fields = array(
			'chat'  => array(
				'label' => __( 'Chat model', 'wellness-chatbot' ),
				'help'  => __( 'Used for live conversation turns.', 'wellness-chatbot' ),
			),
			'cheap' => array(
				'label' => __( 'Fast / cheap model', 'wellness-chatbot' ),
				'help'  => __( 'Used for high-volume, low-risk work such as language detection.', 'wellness-chatbot' ),
			),
			'label' => array(
				'label' => __( 'Labeling model', 'wellness-chatbot' ),
				'help'  => __( 'Used for AI product auto-labeling, where accuracy matters most.', 'wellness-chatbot' ),
			),
		);

		echo '<table class="form-table" role="presentation"><tbody>';
		foreach ( $fields as $key => $field ) {
			$input_id = 'wwc_model_' . $key;
			printf(
				'<tr><th scope="row"><label for="%1$s">%2$s</label></th><td><input type="text" id="%1$s" class="regular-text wwc-model-input" name="model_%3$s" data-tier="%3$s" value="%4$s" placeholder="%5$s" autocomplete="off" /><p class="description">%6$s</p></td></tr>',
				esc_attr( $input_id ),
				esc_html( $field['label'] ),
				esc_attr( $key ),
				esc_attr( $overrides[ $key ] ),
				esc_attr__( 'backend default', 'wellness-chatbot' ),
				esc_html( $field['help'] )
			);
		}
		echo '</tbody></table>';

		printf(
			'<p><button type="button" class="button" id="wwc-fetch-models">%s</button></p>',
			esc_html__( 'Show available models from OpenAI', 'wellness-chatbot' )
		);
		echo '<div id="wwc-model-list" class="wwc-model-list" hidden></div>';
	}

	/**
	 * Proxies to the backend, which asks OpenAI directly for the model ids
	 * this API key can actually use right now — never a list hardcoded in
	 * this plugin, since that would just go stale the same way the shipped
	 * defaults did.
	 */
	public static function ajax_fetch_openai_models() {
		check_ajax_referer( 'wwc_admin', 'nonce' );
		if ( ! WWC_Roles::can_manage() ) {
			wp_send_json_error( array( 'message' => __( 'You do not have permission to do that.', 'wellness-chatbot' ) ), 403 );
			return;
		}

		$response = WWC_Backend_Client::get( '/api/admin/openai/models' );
		if ( is_wp_error( $response ) ) {
			wp_send_json_error( array( 'message' => $response->get_error_message() ), 502 );
			return;
		}
		if ( empty( $response['ok'] ) ) {
			wp_send_json_error(
				array(
					'message' => isset( $response['error'] )
						? (string) $response['error']
						: __( 'The backend could not reach OpenAI. Check OPENAI_API_KEY and the server\'s network access.', 'wellness-chatbot' ),
				),
				502
			);
			return;
		}

		wp_send_json_success( $response );
	}

	private static function render_maintenance() {
		echo '<h2>' . esc_html__( 'Catalogue', 'wellness-chatbot' ) . '</h2>';
		echo '<p class="description">' . esc_html__( 'The backend never connects to this site to fetch products — day-to-day changes reach it automatically when you save a product. For the first load, or to resync everything at once, export a file here and upload it back.', 'wellness-chatbot' ) . '</p>';

		echo '<h3>' . esc_html__( 'Export', 'wellness-chatbot' ) . '</h3>';
		echo '<p class="description">' . esc_html__( 'Downloads every published product as one file. Reading your own product list like this costs about the same as opening the admin product list once — nothing like the load of hundreds of API calls.', 'wellness-chatbot' ) . '</p>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( 'wwc_export_catalogue' );
		echo '<input type="hidden" name="action" value="wwc_export_catalogue" />';
		printf( '<p><button type="submit" class="button">%s</button></p>', esc_html__( 'Export catalogue', 'wellness-chatbot' ) );
		echo '</form>';

		echo '<h3>' . esc_html__( 'Upload', 'wellness-chatbot' ) . '</h3>';
		echo '<p class="description">' . esc_html__( 'Send an exported file to the backend. It is forwarded in small batches, so even a large catalogue does not become one huge request.', 'wellness-chatbot' ) . '</p>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" enctype="multipart/form-data">';
		wp_nonce_field( 'wwc_upload_catalogue' );
		echo '<input type="hidden" name="action" value="wwc_upload_catalogue" />';
		printf(
			'<p><input type="file" name="catalogue_file" accept="application/json,.json" required="required" /></p>'
		);
		printf(
			'<p><label><input type="checkbox" name="reindex" value="1" checked="checked" /> %s</label></p>',
			esc_html__( 'Rebuild the search index afterwards', 'wellness-chatbot' )
		);
		printf(
			'<p><label><input type="checkbox" name="label" value="1" /> %s</label></p>',
			esc_html__( 'Also run AI labeling on products that have no draft yet (uses OpenAI credit). Labeling is direct — products go straight to verified and recommendable, no review step.', 'wellness-chatbot' )
		);
		printf(
			'<p class="wwc-label-limit"><label>%s <input type="number" name="label_limit" value="25" min="1" max="1000" class="small-text" /></label><br /><span class="description">%s</span></p>',
			esc_html__( 'Label at most this many products this run:', 'wellness-chatbot' ),
			esc_html__( 'Always has a limit — this can never label your whole catalogue in one uncontrolled, unbudgeted run. Try a small number first, check the results and the cost, then raise it and run again for more.', 'wellness-chatbot' )
		);
		printf(
			'<p><label><input type="checkbox" name="prune" value="1" /> %s</label><br /><span class="description">%s</span></p>',
			esc_html__( 'Remove products the backend has that this file does not', 'wellness-chatbot' ),
			esc_html__( 'Only tick this for a complete, current export — it deletes anything missing from the file.', 'wellness-chatbot' )
		);
		printf( '<p><button type="submit" class="button button-primary">%s</button></p>', esc_html__( 'Upload catalogue', 'wellness-chatbot' ) );
		echo '</form>';

		echo '<p class="description">' . esc_html__( 'Prefer the command line? SSH in and run: wp wellness-chatbot export — then copy the file to the backend server and run npm run import:prod.', 'wellness-chatbot' ) . '</p>';
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

		if ( WWC_Settings::is_connected() ) {
			// Push the facts to the backend so the assistant reads them live.
			WWC_Backend_Client::post( '/api/admin/settings', $business );

			// Blank means "use the backend's own default" — sent as null so an
			// override that was set can be cleared by emptying the field, not
			// just left stuck at whatever was chosen last.
			$models = array();
			foreach ( array( 'chat', 'cheap', 'label' ) as $tier ) {
				$value              = isset( $_POST[ 'model_' . $tier ] ) ? sanitize_text_field( wp_unslash( $_POST[ 'model_' . $tier ] ) ) : '';
				$models[ $tier ] = '' === $value ? null : $value;
			}
			WWC_Backend_Client::post( '/api/admin/openai/model-overrides', $models );
		}

		WWC_Admin::redirect_back( self::PAGE, array( 'wwc_notice' => 'saved' ) );
	}

	/**
	 * Generates the export file and streams it straight to the browser as a
	 * download — nothing is sent to the backend from this action.
	 */
	public static function handle_export() {
		WWC_Admin::verify_post( 'wwc_export_catalogue' );

		$file   = trailingslashit( WWC_Exporter::export_dir() ) . WWC_Exporter::default_filename();
		$result = WWC_Exporter::export_to_file( $file );

		if ( is_wp_error( $result ) ) {
			WWC_Admin::redirect_back( self::PAGE, array( 'wwc_notice' => 'failed' ) );
		}

		nocache_headers();
		header( 'Content-Type: application/json' );
		header( 'Content-Disposition: attachment; filename="' . basename( $file ) . '"' );
		header( 'Content-Length: ' . filesize( $file ) );
		readfile( $file ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_readfile
		exit;
	}

	/**
	 * Forwards an uploaded export file to the backend, in batches, then asks it
	 * to rebuild the search index (and, if asked, prune and/or label).
	 */
	public static function handle_upload() {
		WWC_Admin::verify_post( 'wwc_upload_catalogue' );

		if ( empty( $_FILES['catalogue_file']['tmp_name'] ) || UPLOAD_ERR_OK !== $_FILES['catalogue_file']['error'] ) {
			WWC_Admin::redirect_back( self::PAGE, array( 'wwc_notice' => 'failed' ) );
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents, WordPress.Security.ValidatedSanitizedInput.MissingUnslash
		$raw  = file_get_contents( $_FILES['catalogue_file']['tmp_name'] );
		$data = json_decode( (string) $raw, true );
		$products = ( is_array( $data ) && isset( $data['products'] ) && is_array( $data['products'] ) )
			? $data['products']
			: ( is_array( $data ) ? $data : null );

		if ( empty( $products ) ) {
			WWC_Admin::redirect_back( self::PAGE, array( 'wwc_notice' => 'failed' ) );
		}

		$ids    = array();
		$failed = false;

		foreach ( array_chunk( $products, 100 ) as $chunk ) {
			foreach ( $chunk as $product ) {
				if ( isset( $product['id'] ) ) {
					$ids[] = (int) $product['id'];
				}
			}

			$response = WWC_Backend_Client::post(
				'/api/admin/catalogue/import',
				array( 'products' => $chunk ),
				array( 'timeout' => 60 )
			);

			if ( is_wp_error( $response ) ) {
				$failed = true;
				break;
			}
		}

		if ( ! $failed ) {
			// A missing, blank or non-positive value falls back to a safe
			// default rather than being sent as-is — an empty/zero limit would
			// otherwise mean "no limit" once it reaches the backend, which is
			// exactly the unbounded run this field exists to prevent.
			$label_limit = isset( $_POST['label_limit'] ) ? absint( $_POST['label_limit'] ) : 0;
			if ( $label_limit < 1 ) {
				$label_limit = 25;
			}

			$response = WWC_Backend_Client::post(
				'/api/admin/catalogue/finish',
				array(
					'reindex'     => ! empty( $_POST['reindex'] ),
					'label'       => ! empty( $_POST['label'] ),
					'limit'       => $label_limit,
					'prune'       => ! empty( $_POST['prune'] ),
					'product_ids' => $ids,
				),
				array( 'timeout' => 300 )
			);
			$failed = is_wp_error( $response );
		}

		WWC_Admin::redirect_back( self::PAGE, array( 'wwc_notice' => $failed ? 'failed' : 'saved' ) );
	}
}
